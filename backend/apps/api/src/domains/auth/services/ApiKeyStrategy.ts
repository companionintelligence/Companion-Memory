import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { Strategy } from 'passport';

import { ContextService, SYSTEM_USER } from '@ci/common/context';
import { UserService } from '@ci/domains/user';

import { ApiKeyService } from './ApiKeyService';

const API_KEY_HEADER = 'x-api-key';

/**
 * Minimal passport strategy that passes the incoming request to the verify
 * callback. This is functionally identical to what `passport-custom` provides
 * but avoids adding an unmaintained dependency for ~15 lines of code.
 */
class RequestStrategy extends Strategy {
  private _verify: (req: Request, done: (err: unknown, user?: unknown) => void) => void;

  constructor(verify: (req: Request, done: (err: unknown, user?: unknown) => void) => void) {
    super();
    this._verify = verify;
  }

  authenticate(req: Request) {
    this._verify(req, (err, user) => {
      if (err) {
        return this.error(err as Error);
      }

      if (!user) {
        return this.fail('Unauthorized', 401);
      }

      this.success(user as object);
    });
  }
}

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(RequestStrategy, 'api-key') {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly userService: UserService,
  ) {
    super();
  }

  async validate(req: Request) {
    const apiKey = req.get(API_KEY_HEADER);

    if (!apiKey) {
      return null;
    }

    const result = await this.apiKeyService.validateKey(apiKey);

    if (!result) {
      return null;
    }

    const user = await this.userService.findById({ userId: SYSTEM_USER }, result.userId);

    if (!user) {
      return null;
    }

    ContextService.set({
      userId: user.id,
    });

    return user;
  }
}
