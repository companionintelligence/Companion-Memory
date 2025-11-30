import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { z } from 'zod';

import { ContextService } from '@ci/common/services';
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
      throw new BadRequestException({
        message: 'JWT payload validation failed',
        errors: result.error.issues,
      });
    }

    const user = await this.userService.findOne(payload.sub);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    ContextService.set({
      userId: user.id,
    });

    return user;
  }
}
