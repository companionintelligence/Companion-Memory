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
import { JwtAuthGuard } from '@ci/common/guards';
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
  /** Required whenever the account has a password the user chose — see `requireReauth` below. */
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
/**
 * How recently a session must have been established for an account that has no
 * password of its own to change its email or set a password without further
 * proof. The same "sudo mode" idea as a forge's re-authentication window.
 */
export const REAUTH_SESSION_WINDOW_MS = 10 * 60 * 1000;

/** The `message` a 401 from `requireReauth` carries when signing in again is the answer. */
export const REAUTH_REQUIRED = 'REAUTH_REQUIRED';

/**
 * Session-only, on every route. An API key is for reading and writing data on
 * a person's behalf; it must never be able to change the credentials it hangs
 * off. Under the `JwtOrApiKeyAuthGuard` these routes had, a `write` key — the
 * level every new key is minted at — could set a password it knew and move the
 * email, and on a Portal-signed-in account nothing asked it for anything
 * (2026-09-24 audit).
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
  @UseGuards(JwtAuthGuard)
  async get(
    @Context() context: RequestContext,
  ): Promise<{ email: string; hasFederatedIdentity: boolean; hasOwnPassword: boolean }> {
    const serviceContext = toServiceContext(context);
    const user = await this.requireUser(serviceContext);
    const federatedIdentities = await this.federatedIdentityService.listForUser(user.id);

    // `hasOwnPassword` is what the settings page keys the current-password field on: a
    // federated account that has set a password of its own is asked for it like any other.
    return {
      email: user.email,
      hasFederatedIdentity: federatedIdentities.length > 0,
      hasOwnPassword: Boolean(user.passwordSetAt),
    };
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
  @UseGuards(JwtAuthGuard)
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
   * controls. `requireReauth` asks for the current password wherever the user
   * has one, and for a recent sign-in otherwise.
   */
  @Patch('email')
  @UseGuards(JwtAuthGuard)
  async changeEmail(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body(new ValidationPipe(changeEmailSchema)) input: { newEmail: string; currentPassword?: string },
  ): Promise<{ email: string }> {
    const serviceContext = toServiceContext(context);
    const user = await this.requireUser(serviceContext);

    await this.requireReauth(user, input.currentPassword, req);

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
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body(new ValidationPipe(changePasswordSchema)) input: { newPassword: string; currentPassword?: string },
  ): Promise<void> {
    const serviceContext = toServiceContext(context);
    const user = await this.requireUser(serviceContext);

    await this.requireReauth(user, input.currentPassword, req);
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
   * Prove the caller is the account's owner before an email or password change.
   *
   * The proof is the current password wherever the user has one they chose:
   * every account that signed up with one, and a federated account that has
   * since set one (`passwordSetAt`). The old rule exempted any account with a
   * federated identity for good — reasonable for a Portal-provisioned account
   * holding a random password it has never seen (`OidcController`,
   * `PortalTokenService`), but it kept applying after that account had chosen a
   * password, and it asked a stolen session for nothing.
   *
   * An account with no password of its own is asked for the next best thing:
   * a session established within {@link REAUTH_SESSION_WINDOW_MS}. Sign-in time
   * survives token rotation (it is the session row's, not the token's), and a
   * caller with only an access token and no session cookie cannot prove it, so
   * they get the same answer as a stale one: 401 `REAUTH_REQUIRED`, which the
   * settings page turns into "sign in again".
   */
  private async requireReauth(user: User, currentPassword: string | undefined, req: Request): Promise<void> {
    const federatedIdentities = await this.federatedIdentityService.listForUser(user.id);
    const mustPresentPassword = federatedIdentities.length === 0 || Boolean(user.passwordSetAt);

    if (!mustPresentPassword) {
      const sessionToken: string | undefined = req.cookies?.[config.auth.cookies.sessionTokenName];
      const establishedAt = sessionToken ? await this.authService.sessionEstablishedAt(user.id, sessionToken) : null;

      if (!establishedAt || Date.now() - establishedAt.getTime() > REAUTH_SESSION_WINDOW_MS) {
        throw new UnauthorizedException({ message: REAUTH_REQUIRED, detail: 'Sign in again to make this change' });
      }

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
