import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UnauthorizedException,
  Get,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { z } from 'zod';

import { Context } from '@ci/common/decorators';
import { JwtAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import { RequestContext } from '@ci/common/types';
import { UserService } from '@ci/domains/user';
import { AuthService } from '@ci/domains/auth/services/AuthService';
import { JwtPayload, LoginDto } from '@ci/domains/auth/types';

const mobileLoginSchema = z.object({
  username: z.string(),
  password: z.string(),
  deviceInfo: z.object({
    deviceId: z.string().optional(),
    deviceName: z.string().optional(),
    platform: z.string().optional(),
    version: z.string().optional(),
  }).optional(),
});

@Controller('mobile/auth')
export class MobileAuthController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
  ) {}

  @Post('login')
  @HttpCode(200)
  async mobileLogin(@Req() req: Request, @Body(new ValidationPipe(mobileLoginSchema)) input: LoginDto & { deviceInfo?: any }) {
    const user = await this.authService.validateUser(input.username, input.password);

    if (user == null) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Enhanced session metadata for mobile devices
    const sessionMeta = {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      deviceId: input.deviceInfo?.deviceId,
      deviceName: input.deviceInfo?.deviceName,
      platform: input.deviceInfo?.platform,
      version: input.deviceInfo?.version,
    };

    const sessionToken = await this.authService.issueSessionToken(user.id, sessionMeta);
    const accessToken = await this.authService.issueAccessToken(user.id);

    return {
      success: true,
      data: {
        sessionToken,
        accessToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      },
      meta: {
        tokenType: 'Bearer',
        expiresIn: '15m', // Access token expiry
        refreshTokenExpiresIn: '7d', // Session token expiry
      },
    };
  }

  @Post('refresh')
  @HttpCode(200)
  async mobileRefresh(@Req() req: Request) {
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

    const sessionMeta = {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };

    const newSessionToken = await this.authService.rotateSessionToken(
      userId,
      sessionToken,
      sessionMeta,
    );
    const accessToken = await this.authService.issueAccessToken(userId);

    return {
      success: true,
      data: {
        sessionToken: newSessionToken,
        accessToken,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      },
      meta: {
        tokenType: 'Bearer',
        expiresIn: '15m',
        refreshTokenExpiresIn: '7d',
      },
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(200)
  async mobileLogout() {
    // In a full implementation, you might want to blacklist the token
    // For now, just return success as the client will discard tokens
    return {
      success: true,
      message: 'Logged out successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('verify')
  async verifyToken(@Context() context: RequestContext) {
    const userId = context.userId;
    
    if (userId == null) {
      throw new UnauthorizedException('Invalid token');
    }

    const user = await this.userService.findOne(userId);

    return {
      success: true,
      data: {
        valid: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
      },
    };
  }
}