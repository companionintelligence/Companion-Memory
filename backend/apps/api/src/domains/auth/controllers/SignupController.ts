import { BadRequestException, Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import type { EntityManager } from 'typeorm';
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
   *
   * This is the answer for the form, which is all it can be: by the time the
   * signup is submitted someone else may have claimed the appliance. `signup`
   * does not act on it — it decides the exemption as it creates the account.
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

    const codesRequired = await this.featureService.isFeatureEnabled('require.signup.codes');

    // Where codes are required the first account needs none (see
    // isSignupCodeRequired), so try this as that account first. Whether it IS
    // the first is decided in the step that creates it: asked beforehand, two
    // people signing up to a fresh appliance at once were both exempt.
    let user = codesRequired
      ? await this.userService.createFirstAccount({ userId: SYSTEM_USER }, { name, email, password })
      : null;

    if (user == null) {
      if (codesRequired) {
        if (signup_code == null) {
          throw new BadRequestException('Must provide a valid signup code');
        }

        // Refuses a code that is no invitation before anything else is looked at — whether the
        // address is taken included, which is not for someone without one to find out. It can only
        // refuse: two signups presenting the same code both pass here. Which of them the code
        // admits is decided as the account is created, by redeeming it.
        const signupCodeLookup = await this.signupCodeService.findOne(signup_code);

        if (!signupCodeLookup) {
          throw new BadRequestException('Must provide a valid signup code');
        }
      }

      const userExists = await this.userService.checkEmailAvailability(email);

      if (userExists) {
        throw new BadRequestException('Email already in use');
      }

      user = await this.userService.create(
        { userId: SYSTEM_USER },
        {
          name,
          email,
          password,
        },
        codesRequired ? (manager) => this.redeem(signup_code!, manager) : undefined,
      );
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

  /**
   * Spend the invitation inside the transaction creating the account it admits — or refuse, which
   * rolls that account back.
   *
   * Of two signups presenting one code, the second to get here finds it used once the first commits
   * and is refused exactly as a signup arriving after it would be. And the code is only spent if the
   * account is created: a signup that fails leaves it for another try.
   */
  private async redeem(signupCode: string, manager: EntityManager): Promise<void> {
    if (!(await this.signupCodeService.consume(signupCode, manager))) {
      throw new BadRequestException('Must provide a valid signup code');
    }
  }
}
