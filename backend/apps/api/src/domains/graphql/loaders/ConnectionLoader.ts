import { Injectable } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { type Connection, ConnectionService } from '@ci/domains/connections';

import { Loader } from './Loader';

@Injectable()
export class ConnectionLoader extends Loader<Connection | null, string> {
  constructor(
    private readonly connectionService: ConnectionService,
    protected readonly logger: LoggerService,
  ) {
    super();
    this.logger.setContext(ConnectionLoader.name);
  }

  protected async batchLoad(
    context: UserServiceContext,
    connectionIds: readonly string[],
  ): Promise<readonly (Connection | null)[]> {
    return this.connectionService.findByIds(context, [...connectionIds]);
  }
}
