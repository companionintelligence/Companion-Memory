import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';

import { ValidationPipe } from '@ci/common/pipes';
import { UserService } from '@ci/domains/user';

import { AuthService } from '../services/AuthService';
import { JwtPayload, LoginDto } from '../types';

const localStrategySchema = z.object({
  username: z.string(),
  password: z.string(),
});

@Controller()
export class SessionController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
  ) {}

  @Post('authenticate')
  @HttpCode(200)
  async login(@Req() req: Request, @Body(new ValidationPipe(localStrategySchema)) input: LoginDto) {
    const user = await this.authService.validateUser(input.username, input.password);

    if (user == null) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const sessionToken = await this.authService.issueSessionToken(user.id, this.getSessionMeta(req));
    const accessToken = await this.authService.issueAccessToken(user.id);

    return {
      sessionToken,
      accessToken,
      user,
    };
  }

  @Post('authenticate/refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request) {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];

    if (!authHeader) {
      throw new UnauthorizedException('No refresh token provided');
    } else if (Array.isArray(authHeader)) {
      throw new BadRequestException('Multiple authorization headers');
    }

    const sessionToken = authHeader.replace(/^Bearer /, '').trim();
    let payload: JwtPayload;

    try {
      payload = this.authService.validateSessionToken(sessionToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const userId = payload.sub;

    const user = await this.userService.findOne(userId);
    const newSessionToken = await this.authService.rotateSessionToken(
      userId,
      sessionToken,
      this.getSessionMeta(req),
    );
    const accessToken = await this.authService.issueAccessToken(userId);

    return {
      sessionToken: newSessionToken,
      accessToken,
      user,
    };
  }

  getSessionMeta(request: Request) {
    return {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    };
  }
}
