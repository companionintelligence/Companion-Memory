import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { type User, UserService } from '@ci/domains/user';

import { AuthService } from '../services/AuthService';
import { FederatedIdentityService } from '../services/FederatedIdentityService';

const deleteAccountSchema = z.object({
  /**
   * The account's own email address, retyped. Not an authorisation check — the bearer
   * credential is that — but a deliberate speed bump in front of an irreversible
   * action, so a stray client call or a mistapped button cannot end an account.
   */
  confirmEmail: z.string().min(1),
});

// Same rule SignupController applies to a new account's password.
const NEW_PASSWORD_SCHEMA = z.string().min(6, 'Password must be at least 6 characters');

const changeEmailSchema = z.object({
  newEmail: z.string().email('Invalid email address'),
  /** Required unless the account is OIDC-linked — see `requireReauth` below. */
  currentPassword: z.string().optional(),
});

const changePasswordSchema = z.object({
  newPassword: NEW_PASSWORD_SCHEMA,
  currentPassword: z.string().optional(),
});

/**
 * Account lifecycle: the counterpart to `SignupController`.
 *
 * Exists because both stores require it. Apple Guideline 5.1.1(v) and Google Play's
 * Data Deletion policy say an app offering in-app account creation must offer in-app
 * account deletion, and Companion's signup page is exactly that. Self-hosting is not
 * an exemption: Apple wants the *initiation* path inside the app even though the data
 * lives on the user's own appliance.
 */
@Controller('account')
export class AccountController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly federatedIdentityService: FederatedIdentityService,
  ) {}

  /** What the account settings UI needs to render itself: address, and whether
   * a current-password prompt even makes sense for this account (see
   * `requireReauth`). */
  @Get()
  @UseGuards(JwtOrApiKeyAuthGuard)
  async get(@Context() context: RequestContext): Promise<{ email: string; hasFederatedIdentity: boolean }> {
    const serviceContext = toServiceContext(context);
    const user = await this.requireUser(serviceContext);
    const federatedIdentities = await this.federatedIdentityService.listForUser(user.id);

    return { email: user.email, hasFederatedIdentity: federatedIdentities.length > 0 };
  }

  /**
   * Delete the authenticated user's account: revoke access now, purge the data later
   * (see `UserService.requestDeletion`).
   *
   * Guarded by `JwtOrApiKeyAuthGuard`, not the `JwtAuthGuard` used by the other
   * sensitive `/keys`-style routes, and that is load-bearing rather than lax. The
   * native app never holds a JWT — it trades one for a durable API key at login and
   * authenticates with `x-api-key` from then on — so a JWT-only route would be
   * unreachable from the App Store build, i.e. unreachable from the only client the
   * requirement is actually about. It does not widen the blast radius either: an
   * attacker holding that key can already read every memory the account has.
   *
   * Password re-authentication is deliberately NOT the confirmation. Accounts created
   * through OIDC are given a random 32-byte password they have never seen
   * (`OidcController`, `PortalTokenService`), so requiring it would make deletion
   * impossible for exactly the users who signed in with CI-Portal. Retyping the email
   * works for every sign-in method.
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtOrApiKeyAuthGuard)
  async remove(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(deleteAccountSchema)) input: { confirmEmail: string },
  ): Promise<void> {
    const serviceContext = toServiceContext(context);
    const user = await this.requireUser(serviceContext);

    // Case- and whitespace-insensitive: the user is retyping to prove intent, not
    // reproducing a stored string byte for byte.
    if (input.confirmEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
      throw new BadRequestException('Confirmation email does not match this account');
    }

    await this.userService.requestDeletion(serviceContext, user.id);
  }

  /**
   * Change the authenticated user's own email. Re-authentication (unlike
   * deletion, above) IS required here, for every account that has a password
   * the user actually knows — an email swap is a takeover vector deletion
   * isn't, since it redirects future logins to an address the attacker
   * controls. `requireReauth` skips it only for OIDC-linked accounts, for the
   * same reason `remove()` skips password confirmation for them.
   */
  @Patch('email')
  @UseGuards(JwtOrApiKeyAuthGuard)
  async changeEmail(
    @Context() context: RequestContext,
    @Body(new ValidationPipe(changeEmailSchema)) input: { newEmail: string; currentPassword?: string },
  ): Promise<{ email: string }> {
    const serviceContext = toServiceContext(context);
    const user = await this.requireUser(serviceContext);

    await this.requireReauth(user, input.currentPassword);

    if (input.newEmail.trim().toLowerCase() === user.email.trim().toLowerCase()) {
      throw new BadRequestException('That is already your email address');
    }

    // Despite the name, this reports whether the email is TAKEN, not free.
    const taken = await this.userService.checkEmailAvailability(input.newEmail);

    if (taken) {
      throw new BadRequestException('That email address is already in use');
    }

    const updated = await this.userService.changeEmail(serviceContext, user.id, input.newEmail);

    return { email: updated?.email ?? input.newEmail };
  }

  /**
   * Change (or, for an OIDC-linked account that has never had a password of
   * its own, set) the authenticated user's password. On success every OTHER
   * session for this account is invalidated — the request making the change
   * stays signed in, everywhere else is forced to re-authenticate.
   */
  @Patch('password')
  @UseGuards(JwtOrApiKeyAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body(new ValidationPipe(changePasswordSchema)) input: { newPassword: string; currentPassword?: string },
  ): Promise<void> {
    const serviceContext = toServiceContext(context);
    const user = await this.requireUser(serviceContext);

    await this.requireReauth(user, input.currentPassword);
    await this.userService.changePassword(serviceContext, user.id, input.newPassword);

    const currentToken: string | undefined = req.cookies?.[config.auth.cookies.sessionTokenName];

    await this.authService.invalidateOtherSessions(user.id, currentToken);
  }

  private async requireUser(serviceContext: ReturnType<typeof toServiceContext>): Promise<User> {
    const user = await this.userService.findById(serviceContext, serviceContext.userId);

    // Already soft-deleted accounts stop resolving, so a replayed request lands here
    // rather than acting on a row that no longer exists.
    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }

  /**
   * Verify the caller actually holds this account's current password before
   * an email/password change — UNLESS the account is OIDC-linked, in which
   * case it was given a random 32-byte password it has never seen
   * (`OidcController`, `PortalTokenService`) and requiring it would make this
   * permanently unreachable for exactly the users who sign in with CI-Portal.
   */
  private async requireReauth(user: User, currentPassword: string | undefined): Promise<void> {
    const federatedIdentities = await this.federatedIdentityService.listForUser(user.id);

    if (federatedIdentities.length > 0) {
      return;
    }

    if (!currentPassword) {
      throw new BadRequestException('Current password is required');
    }

    const validated = await this.userService.validatePassword(user.email, currentPassword);

    if (!validated) {
      throw new UnauthorizedException('Current password is incorrect');
    }
  }
}
