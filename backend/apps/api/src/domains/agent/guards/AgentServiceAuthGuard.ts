import { timingSafeEqual } from 'crypto';

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { ContextService } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { AgentOwnerService } from '../services/AgentOwnerService';

@Injectable()
export class AgentServiceAuthGuard implements CanActivate {
  constructor(
    private readonly ownerService: AgentOwnerService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AgentServiceAuthGuard.name);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType<string>() !== 'http') {
      throw new UnauthorizedException('Agent service auth only supports HTTP requests');
    }

    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: {
        id: string;
      };
    }>();
    const providedKey = request.headers['x-ci-service-key'];
    const expectedKey = config.agent.serviceKey.trim();

    if (expectedKey.length === 0) {
      throw new ServiceUnavailableException('CI_API_SERVICE_KEY is not configured');
    }

    if (!this.keysMatch(expectedKey, providedKey)) {
      this.logger.warn('Rejected agent API request with invalid service key');
      throw new UnauthorizedException('Invalid service key');
    }

    const owner = await this.ownerService.resolveOwner();

    if (!owner.userId) {
      throw new ServiceUnavailableException('CI_OWNER_USER_ID is not configured');
    }

    request.user = {
      id: owner.userId,
    };
    ContextService.set({
      userId: owner.userId,
    });

    return true;
  }

  private keysMatch(expectedKey: string, providedKey: string | string[] | undefined): boolean {
    if (typeof providedKey !== 'string') {
      return false;
    }

    const expected = Buffer.from(expectedKey, 'utf8');
    const received = Buffer.from(providedKey, 'utf8');

    if (expected.length !== received.length) {
      return false;
    }

    return timingSafeEqual(expected, received);
  }
}
