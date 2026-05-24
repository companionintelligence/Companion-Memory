import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { z } from 'zod';

import { ContextService, SYSTEM_USER } from '@ci/common/context';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { JwtPayload } from '../types';

const jwtPayloadSchema = z.object({
  sub: z.string(),
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
