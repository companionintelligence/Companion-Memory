import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { UserEntity } from '@ci/domains/user';

@Injectable()
export class AgentOwnerService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentOwnerService.name);
  }

  async resolveOwner(): Promise<{ userId: string | null; selection: 'configured' | 'auto' | 'unavailable' }> {
    const configuredUserId = config.agent.ownerUserId.trim();

    if (configuredUserId.length > 0) {
      return {
        userId: configuredUserId,
        selection: 'configured',
      };
    }

    const firstOnboardedUser = await this.userRepository.findOne({
      where: {
        onboarded: true,
      },
      order: {
        createdAt: 'ASC',
      },
    });

    if (firstOnboardedUser) {
      this.logger.warn('Using first onboarded user as agent owner because CI_OWNER_USER_ID is unset', {
        userId: firstOnboardedUser.id,
      });

      return {
        userId: firstOnboardedUser.id,
        selection: 'auto',
      };
    }

    return {
      userId: null,
      selection: 'unavailable',
    };
  }
}
