import { BadRequestException, Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { z } from 'zod';

import { SYSTEM_USER } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { ValidationPipe } from '@ci/common/pipes';
import { UserService } from '@ci/domains/user';

import { CsrfGuard } from '../guards/CsrfGuard';
import { AuthService } from '../services/AuthService';
import { CsrfService } from '../services/CsrfService';
import { SignupCodeService } from '../services/SignupCodeService';
import { SignupDto } from '../types';
import { setCsrfCookie, setSessionCookie } from '../utils/authCookies';

const signupSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
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

  /**
   * Whether a signup code is required *right now*.
   *
   * The feature flag ships on, which on a self-hosted appliance meant nobody
   * could ever create the first account: the code table starts empty, no
   * migration seeds it, and nothing in the product mints one — so the box a
   * user just installed had no way in at all.
   *
   * An appliance with zero accounts has nothing to protect yet, so the first
   * one is always allowed. The gate closes again the moment it exists, which is
   * the only window that matters — everyone after the owner still needs a code
   * wherever the flag is on.
   */
  private async isSignupCodeRequired(): Promise<boolean> {
    if (!(await this.featureService.isFeatureEnabled('require.signup.codes'))) {
      return false;
    }

    return !(await this.userService.hasNoUsers());
  }

  /**
   * What the signup form needs to render itself correctly, before the user has
   * an account and therefore before any authenticated query is available.
   * Public by necessity, and says nothing an unauthenticated caller could not
   * already learn by posting an empty signup.
   */
  @Get('signup/requirements')
  async signupRequirements() {
    return { codeRequired: await this.isSignupCodeRequired() };
  }

  @Post('signup')
  @UseGuards(CsrfGuard)
  async signup(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ValidationPipe(signupSchema)) input: SignupDto,
  ) {
    const { name, email, password, signup_code } = input;

    const isSignupCodeRequired = await this.isSignupCodeRequired();

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

    const { sessionToken, sessionId } = await this.authService.issueSessionToken(
      user.id,
      this.authService.getSessionMetadata(req),
    );

    const accessToken = await this.authService.issueAccessToken(user.id);

    setSessionCookie(req, res, sessionToken);

    // Identity boundary: mint a fresh CSRF token bound to the new session, for
    // authenticated requests (e.g. /refresh). Auth boundaries are the only
    // rotation points — see utils/authCookies.ts.
    setCsrfCookie(req, res, this.csrfService.generateToken(sessionId));

    return {
      accessToken,
    };
  }
}
