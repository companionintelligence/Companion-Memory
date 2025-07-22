import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { z } from 'zod';

import { RequestWithContext } from '@ci/common/types';
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

  async validate(req: RequestWithContext, payload: JwtPayload) {
    const result = jwtPayloadSchema.safeParse(payload);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: result.error.issues,
      });
    }

    const user = await this.userService.findOne(payload.sub);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    req.context = {
      ...req.context,
      userId: user.id,
    };

    return user;
  }
}
