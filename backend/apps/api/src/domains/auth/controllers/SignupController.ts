import { BadRequestException, Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import parseDuration from 'parse-duration';
import { z } from 'zod';

import { SYSTEM_USER } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { UserService } from '@ci/domains/user';

import { CsrfGuard } from '../guards/CsrfGuard';
import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';
import { SignupCodeService } from '../services/SignupCodeService';
import { SignupDto } from '../types';

const COOKIE_MAX_AGE = parseDuration(config.auth.jwt.refreshTokenExpiration) ?? 0;

const CSRF_COOKIE_NAME = config.auth.cookies.csrfTokenName;

const signupSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 chars'),
  signup_code: z.string().optional(),
});

@Controller()
export class SignupController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly signupCodeService: SignupCodeService,
    private readonly featureService: FeatureService,
    private readonly csrfService: CsrfService,
  ) {}

  @Post('signup')
  @UseGuards(CsrfGuard)
  async signup(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ValidationPipe(signupSchema)) input: SignupDto,
  ) {
    const { name, email, password, signup_code } = input;

    const isSignupCodeRequired = await this.featureService.isFeatureEnabled('require.signup.codes');

    if (isSignupCodeRequired) {
      if (signup_code == null) {
        throw new BadRequestException('Must provide a valid signup code');
      }

      const signupCodeLookup = await this.signupCodeService.findOne(signup_code);

      if (!signupCodeLookup) {
        throw new BadRequestException('Must provide a valid signup code');
      }
    }

    const userExists = await this.userService.checkEmailAvailability(email);

    if (userExists) {
      throw new BadRequestException('Email already in use');
    }

    const user = await this.userService.create(
      { userId: SYSTEM_USER },
      {
        name,
        email,
        password,
      },
    );

    if (isSignupCodeRequired) {
      await this.signupCodeService.update(signup_code!, {
        used: true,
      });
    }

    const sessionToken = await this.authService.issueSessionToken(
      user.id,
      this.authService.getSessionMetadata(req),
    );

    const accessToken = await this.authService.issueAccessToken(user.id);

    res.cookie(config.auth.cookies.sessionTokenName, sessionToken, {
      httpOnly: true,
      secure: req.secure,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE,
    });

    // Issue a fresh CSRF token for authenticated requests (e.g. /refresh)
    const csrfToken = this.csrfService.generateToken();

    this.setCsrfCookie(req, res, csrfToken);

    return {
      accessToken,
    };
  }

  private setCsrfCookie(req: Request, res: Response, token: string): void {
    res.cookie(CSRF_COOKIE_NAME, token, {
      httpOnly: false,
      secure: req.secure,
      sameSite: 'strict',
      path: '/',
    });
  }
}
