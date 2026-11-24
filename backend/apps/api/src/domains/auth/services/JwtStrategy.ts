import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { z } from 'zod/v3';

import { ContextService, SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { RUN_TOKEN_PURPOSE, runTokenMayAuthenticate } from '../runTokenAccess';
import { JwtPayload } from '../types';

const jwtPayloadSchema = z.object({
  sub: z.string(),
  purpose: z.unknown().optional(),
});

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly userService: UserService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.auth.jwt.authTokenSecret,
      passReqToCallback: true,
    });
  }

  async validate(req: Request, payload: JwtPayload) {
    const result = jwtPayloadSchema.safeParse(payload);

    if (!result.success) {
      return null;
    }

    // A session token carries no `purpose`. Anything else signed with this secret was minted for one
    // job and is not a sign-in: only a Python run token, and only for the read queries the sidecars
    // send (`runTokenAccess.ts`).
    if (
      result.data.purpose !== undefined &&
      !(result.data.purpose === RUN_TOKEN_PURPOSE && runTokenMayAuthenticate(req))
    ) {
      return null;
    }

    const user = await this.userService.findById({ userId: SYSTEM_USER }, payload.sub);

    if (!user) {
      return null;
    }

    ContextService.set({
      userId: user.id,
    });

    return user;
  }
}
