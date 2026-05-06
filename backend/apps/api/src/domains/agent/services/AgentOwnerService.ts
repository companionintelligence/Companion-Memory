import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

@Injectable()
export class AgentOwnerService {
  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(AgentOwnerService.name);
  }

  async resolveOwner(): Promise<{ userId: string | null; selection: 'configured' | 'unavailable' }> {
    const configuredUserId = config.agent.ownerUserId.trim();

    if (configuredUserId.length > 0) {
      return {
        userId: configuredUserId,
        selection: 'configured',
      };
    }

    this.logger.warn('CI_OWNER_USER_ID is unset; refusing to infer an agent owner from application users');

    return {
      userId: null,
      selection: 'unavailable',
    };
  }
}
