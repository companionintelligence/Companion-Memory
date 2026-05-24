import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import parseDuration from 'parse-duration';
import { z } from 'zod';

import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { CsrfGuard } from '../guards/CsrfGuard';
import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';
import { JwtPayload, LoginDto } from '../types';

const COOKIE_MAX_AGE = parseDuration(config.auth.jwt.refreshTokenExpiration) ?? 0;

const CSRF_COOKIE_NAME = config.auth.cookies.csrfTokenName;

const localStrategySchema = z.object({
  username: z.string(),
  password: z.string(),
});

@Controller('authenticate')
export class SessionController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly csrfService: CsrfService,
  ) {}

  /**
   * Issue a pre-auth CSRF token cookie. The frontend should call this before
   * submitting the login form and include the token as an `X-CSRF-Token`
   * header on the POST /authenticate request.
   */
  @Get('csrf')
  @HttpCode(204)
  issueCsrfToken(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.csrfService.generateToken();

    this.setCsrfCookie(req, res, token);
  }

  @Post()
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ValidationPipe(localStrategySchema)) input: LoginDto,
  ) {
    const user = await this.userService.validatePassword(input.username, input.password);

    if (user == null) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const sessionToken = await this.authService.issueSessionToken(
      user.id,
      this.authService.getSessionMetadata(req),
    );

    const accessToken = await this.authService.issueAccessToken(user.id);
    const csrfToken = this.csrfService.generateToken();

    res.cookie(config.auth.cookies.sessionTokenName, sessionToken, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    });

    this.setCsrfCookie(req, res, csrfToken);

    return {
      accessToken,
    };
  }

  @Post('refresh')
  @HttpCode(200)
  @UseGuards(CsrfGuard)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.getSessionToken(req);
    const payload = this.validateSessionToken(token);
    const userId = payload.sub;
    const user = await this.userService.findById({ userId }, userId);

    if (!user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const { sessionToken } = await this.authService.rotateSessionToken(
      userId,
      token,
      this.authService.getSessionMetadata(req),
    );

    const accessToken = await this.authService.issueAccessToken(userId);

    // If we obtain a new session token from calling `rotateSessionToken` then
    // we conclude that we have not matched a grace-period rotation and must set
    // a new cookie value.
    //
    // Otherwise we have a grace-period match and we avoid setting a new cookie.
    // The browser keeps the cookie from the first concurrent request that
    // performed the real rotation.
    if (sessionToken) {
      res.cookie(config.auth.cookies.sessionTokenName, sessionToken, {
        httpOnly: true,
        secure: req.secure,
        sameSite: 'lax',
        path: '/',
        maxAge: COOKIE_MAX_AGE,
      });

      const csrfToken = this.csrfService.generateToken();

      this.setCsrfCookie(req, res, csrfToken);
    }

    return {
      accessToken,
    };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.getSessionToken(req);
    const payload = this.validateSessionToken(token);
    const userId = payload.sub;
    const user = await this.userService.findById({ userId }, userId);

    if (!user) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    await this.authService.invalidateSession(userId, token, this.authService.getSessionMetadata(req));

    res.clearCookie(config.auth.cookies.sessionTokenName, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      path: '/',
    });

    this.clearCsrfCookie(req, res);
  }

  private getSessionToken(req: Request) {
    return req.cookies?.[config.auth.cookies.sessionTokenName];
  }

  private validateSessionToken(token: string | null | undefined): JwtPayload {
    if (token == null) {
      throw new BadRequestException('No token provided');
    }

    try {
      return this.authService.validateSessionToken(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private setCsrfCookie(req: Request, res: Response, token: string): void {
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false,
      secure: req.secure,
      sameSite: 'strict',
      path: '/',
    });
  }

  private clearCsrfCookie(req: Request, res: Response): void {
    res.clearCookie(CSRF_COOKIE_NAME, {
      httpOnly: false,
      secure: req.secure,
      sameSite: 'strict',
      path: '/',
    });
  }
}
