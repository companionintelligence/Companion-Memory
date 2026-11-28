import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Patch,
  Header,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod/v3';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { FULL_CAPABILITY, RequireCapability } from '@ci/common/decorators';
import { type ApiKeyScopedRequest, JwtAuthGuard, JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { ValidationPipe } from '@ci/common/pipes';
import config from '@ci/configuration';
import { LastAdminDeletionRefused, type User, UserService } from '@ci/domains/user';

import { AccountRecoveryService } from '../services/AccountRecoveryService';
import { ApiKeyService } from '../services/ApiKeyService';
import { AuthService } from '../services/AuthService';
import { FederatedIdentityService } from '../services/FederatedIdentityService';
import { HubForwardAuthBridgeService } from '../services/HubForwardAuthBridgeService';
import { LoginThrottleService } from '../services/LoginThrottleService';
import { isManagedAppPrincipal } from '../types';
import { COMPANION_LINK_COOKIE, COMPANION_LINK_TTL_MS, signCompanionLink } from '../utils/companionLink';
import { newPasswordSchema } from '../utils/passwordPolicy';

const deleteAccountSchema = z.object({
  /**
   * The account's own email address, retyped. Not an authorisation check — the bearer
   * credential is that — but a deliberate speed bump in front of an irreversible
   * action, so a stray client call or a mistapped button cannot end an account.
   */
  confirmEmail: z.string().min(1),
  /**
   * Who becomes administrator, by the address they sign in with. Required only when this is the
   * appliance's last live administrator and other people still have accounts; see
   * `UserService.requestDeletion`.
   */
  successorEmail: z.string().trim().min(1).optional(),
});

// Same rule SignupController applies to a new account's password.
const NEW_PASSWORD_SCHEMA = newPasswordSchema;

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
 * How recently a session must have been established for an account that has no
 * password of its own to change its email or set a password without further
 * proof. The same "sudo mode" idea as a forge's re-authentication window.
 */
export const REAUTH_SESSION_WINDOW_MS = 10 * 60 * 1000;

/** The `message` a 401 from `requireReauth` carries when signing in again is the answer. */
export const REAUTH_REQUIRED = 'REAUTH_REQUIRED';

/** Why `PATCH /account/email` refuses a request the Hub signs in as this account — see `changeEmail`. */
export const EMAIL_MANAGED_BY_HUB =
  'Your Hub signs you in to Memory with this email address, so it cannot be changed here';

/** The `message` values of a 409 from `DELETE /account`; see `LastAdminDeletionRefused`. */
export { SUCCESSOR_NOT_FOUND, SUCCESSOR_REQUIRED } from '@ci/domains/user';

/**
 * Account lifecycle: the counterpart to `SignupController`.
 *
 * Exists because both stores require it. Apple Guideline 5.1.1(v) and Google Play's
 * Data Deletion policy say an app offering in-app account creation must offer in-app
 * account deletion, and Companion's signup page is exactly that. Self-hosting is not
 * an exemption: Apple wants the *initiation* path inside the app even though the data
 * lives on the user's own appliance.
 *
 * Session-only on every route except deletion. An API key is for reading and
 * writing data on a person's behalf; it must never be able to change the
 * credentials it hangs off. Under the `JwtOrApiKeyAuthGuard` these routes had, a
 * `write` key — the level every new key is minted at — could set a password it
 * knew and move the email, and on a Portal-signed-in account nothing asked it for
 * anything (2026-09-24 audit). Deletion takes a key because the app the stores
 * require it of holds nothing else; see `remove`.
 */
@Controller('account')
export class AccountController {
  constructor(
    private readonly userService: UserService,
    private readonly authService: AuthService,
    private readonly federatedIdentityService: FederatedIdentityService,
    private readonly hubBridge: HubForwardAuthBridgeService,
    private readonly apiKeyService: ApiKeyService,
    private readonly loginThrottle: LoginThrottleService,
    private readonly recovery: AccountRecoveryService,
  ) {}

  /** What the account settings UI needs to render itself: address, whether a
   * current-password prompt even makes sense for this account (see
   * `requireReauth`), and whether the address is the Hub's to change (see
   * `changeEmail`). */
  @Get()
  @UseGuards(JwtAuthGuard)
  async get(
    @Context() context: RequestContext,
    @Req() req: Request,
  ): Promise<{
    email: string;
    hasFederatedIdentity: boolean;
    hasOwnPassword: boolean;
    emailManagedByHub: boolean;
    /** The Companion (Portal) sign-in connected to this account, by its address, or null. */
    companionAccount: { email: string | null } | null;
    /** Whether this Memory can connect a Companion sign-in at all (OIDC is configured). */
    companionAvailable: boolean;
  }> {
    const serviceContext = toServiceContext(context);
    const user = await this.requireUser(serviceContext);
    const federatedIdentities = await this.federatedIdentityService.listForUser(user.id);

    // `hasOwnPassword` is what the settings page keys the current-password field on, for
    // exactly the reason `requireReauth` keys on it — whatever the account's sign-in method.
    const companion = await this.federatedIdentityService.listForUser(user.id, { oidcOnly: true });

    return {
      email: user.email,
      hasFederatedIdentity: federatedIdentities.length > 0,
      hasOwnPassword: Boolean(user.passwordSetAt),
      emailManagedByHub: await this.hubBridge.namesAccount(req, user),
      companionAccount: companion.length > 0 ? { email: companion[0].email ?? null } : null,
      companionAvailable: Boolean(config.auth.oidc.issuerUrl),
    };
  }

  /**
   * Start connecting a Companion (Portal) sign-in to this account, for someone signed in to it.
   *
   * The first account's typed address no longer counts as proven (`UserService`), so an owner who
   * set up with a password could not otherwise add Portal sign-in: the Portal's verified address
   * matches no PROVEN account and is refused. Here the person proves the account itself instead,
   * with the same check an email or password change asks (`requireReauth`), and the Portal round
   * trip proves the identity. The callback (`OidcController`) links them by (issuer, subject),
   * whatever address either side carries.
   *
   * Sets a signed cookie naming this account and session (`companionLink.ts`) and answers where
   * to send the browser; the Portal sign-in it starts is the ordinary one.
   */
  @Post('companion-link')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async startCompanionLink(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body(new ValidationPipe(z.object({ currentPassword: z.string().optional() })))
    input: { currentPassword?: string },
  ): Promise<{ redirect: string }> {
    const user = await this.requireUser(toServiceContext(context));

    if (!config.auth.oidc.issuerUrl) {
      throw new ConflictException('Companion sign-in is not set up on this Memory');
    }

    if ((await this.federatedIdentityService.listForUser(user.id, { oidcOnly: true })).length > 0) {
      throw new ConflictException('A Companion account is already connected');
    }

    const sessionToken: string | undefined = req.cookies?.[config.auth.cookies.sessionTokenName];

    // The link is bound to this browser's session, so it needs one: a bearer token alone (an API
    // client) has no browser to carry the round trip.
    if (!sessionToken) {
      throw new BadRequestException('Connect a Companion account from a web sign-in');
    }

    await this.requireReauth(user, input.currentPassword, req);

    res.cookie(
      COMPANION_LINK_COOKIE,
      signCompanionLink(config.auth.jwt.authTokenSecret, user.id, sessionToken),
      {
        httpOnly: true,
        secure: req.secure,
        sameSite: 'lax',
        path: '/',
        maxAge: COMPANION_LINK_TTL_MS,
      },
    );

    return { redirect: '/api/authenticate/oidc' };
  }

  /**
   * Disconnect the Companion (Portal) sign-in from this account. Refused while the account has no
   * password of its own: the Portal is then its only way in, and removing it would lock the
   * person out.
   */
  @Delete('companion-link')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeCompanionLink(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body(new ValidationPipe(z.object({ currentPassword: z.string().optional() })))
    input: { currentPassword?: string },
  ): Promise<void> {
    const user = await this.requireUser(toServiceContext(context));

    if (!user.passwordSetAt) {
      throw new ConflictException(
        'Set a password first: without one you could not sign in after disconnecting',
      );
    }

    await this.requireReauth(user, input.currentPassword, req);
    await this.federatedIdentityService.unbindOidc(user.id);
  }

  /**
   * Delete the authenticated user's account: revoke access now, purge the data later
   * (see `UserService.requestDeletion`).
   *
   * Guarded by `JwtOrApiKeyAuthGuard`, not the session-only `JwtAuthGuard` the rest of
   * this controller uses, and that is load-bearing rather than lax. The native app
   * never holds a JWT — it trades one for a durable API key at login and authenticates
   * with `x-api-key` from then on — so a JWT-only route is unreachable from the App
   * Store build, i.e. from the only client the requirement is actually about. #2743
   * proved it by moving this route there with the credential routes: every phone got
   * a 401, which the guard-level `AccountController.guards.test.ts` now pins.
   *
   * That does not reopen what #2743 closed. A key must not change the credentials it
   * hangs off because that hands its holder a password or an address that outlives
   * the key. Deletion hands them nothing: access ends for everyone, the key included.
   * What deletion does is destroy, and destroying is what `full` names — `write`, the
   * level every new key gets by default, is "nothing that deletes". The native app
   * mints its key at `full` (web `useAuth.ts`, #2661) because it already issues the
   * destructive mutations, so a key that can end the account could already empty it.
   * For the grace period an operator can still undo it
   * (`docs/architecture/account-deletion.md`).
   *
   * An installed app's key is refused even at `full`. For a CI-Hub-connected harness,
   * `full` means it may ASK to delete and the owner answers a card
   * (`capabilityForApp`); this route has no card to raise, so ending the account stays
   * the owner's act. Every such key is scope-limited today, which the guard already
   * refuses here; the check keeps that true if an app is ever given the whole surface
   * (`FULL_SURFACE_CONNECT_APPS`).
   *
   * Password re-authentication is deliberately NOT the confirmation. Accounts created
   * through OIDC are given a random 32-byte password they have never seen
   * (`OidcController`, `PortalTokenService`), so requiring it would make deletion
   * impossible for exactly the users who signed in with CI-Portal. Retyping the email
   * works for every sign-in method.
   *
   * The appliance's last administrator cannot leave while other people still have accounts
   * unless they name who takes over (`successorEmail`): 409 `SUCCESSOR_REQUIRED`, or
   * `SUCCESSOR_NOT_FOUND` when the address is not another live account here.
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtOrApiKeyAuthGuard)
  @RequireCapability(FULL_CAPABILITY)
  async remove(
    @Context() context: RequestContext,
    @Req() req: ApiKeyScopedRequest,
    @Body(new ValidationPipe(deleteAccountSchema)) input: { confirmEmail: string; successorEmail?: string },
  ): Promise<void> {
    if (isManagedAppPrincipal({ managedBy: req.apiKeyManagedBy })) {
      throw new ForbiddenException(
        "An installed app cannot delete this account — that is the owner's decision",
      );
    }

    const serviceContext = toServiceContext(context);
    const user = await this.requireUser(serviceContext);

    // Case- and whitespace-insensitive: the user is retyping to prove intent, not
    // reproducing a stored string byte for byte.
    if (input.confirmEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
      throw new BadRequestException('Confirmation email does not match this account');
    }

    try {
      await this.userService.requestDeletion(serviceContext, user.id, {
        successorEmail: input.successorEmail,
      });
    } catch (error) {
      throw error instanceof LastAdminDeletionRefused ? error.toConflict() : error;
    }
  }

  /**
   * Change the authenticated user's own email. Re-authentication (unlike
   * deletion, above) IS required here, for every account that has a password
   * the user actually knows — an email swap is a takeover vector deletion
   * isn't, since it redirects future logins to an address the attacker
   * controls. `requireReauth` asks for the current password wherever the user
   * has one, and for a recent sign-in otherwise.
   *
   * Refused outright (409), before any proof is asked for, while the Hub signs
   * this request in as this account and finds it by this address: a Hub that
   * sends no stable id, or a stable id the bridge has not linked yet. A change
   * would then sign them into a newly created, empty account on the next page
   * load and leave their memories behind an address the Hub never names, so the
   * settings page explains this instead of offering the form. Once the bridge
   * has linked the Hub person's stable id to this account, the link finds them
   * whatever the address says, and the change goes through like any other.
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

    if (await this.hubBridge.namesAccount(req, user)) {
      throw new ConflictException(EMAIL_MANAGED_BY_HUB);
    }

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
   * Change (or, for a Portal-, OIDC- or Hub-provisioned account that has never
   * had a password of its own, set) the authenticated user's password. On
   * success every OTHER session for this account is invalidated — the request
   * making the change stays signed in, everywhere else is forced to
   * re-authenticate.
   *
   * The phone and desktop apps hold no session: they sign in with an API key
   * minted at sign-in (`sign_in` provenance). Those keys are revoked too, or
   * "other devices have been signed out" would be true of browsers only. Keys
   * the person made in Settings > API keys stay, because a password change is
   * routine and those keys run their own tools (the importer, scripts); "Sign
   * out everywhere" is the action that removes them.
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
    await this.apiKeyService.revokeSignInKeys(user.id);
  }

  @Post('recovery-codes')
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'no-store')
  async generateRecoveryCodes(
    @Context() context: RequestContext,
    @Req() req: Request,
    @Body(new ValidationPipe(z.object({ currentPassword: z.string().optional() })))
    input: { currentPassword?: string },
  ): Promise<{ codes: string[] }> {
    const user = await this.requireUser(toServiceContext(context));
    await this.requireReauth(user, input.currentPassword, req);

    return { codes: await this.recovery.generate(user.id, user.credentialsResetAt ?? null) };
  }

  /**
   * Sign this account out of every other browser and app, and revoke every API key it holds
   * except those CI-Hub minted for installed apps (the Hub revokes those when an app is
   * disconnected).
   *
   * For someone who no longer knows who holds what. A key minted with a borrowed session looks
   * exactly like one the owner made, so this removes the keys made in Settings too, and says how
   * many went. The session making the request stays signed in.
   */
  @Post('sign-out-everywhere')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async signOutEverywhere(
    @Context() context: RequestContext,
    @Req() req: Request,
  ): Promise<{ revokedKeys: number }> {
    const serviceContext = toServiceContext(context);
    const user = await this.requireUser(serviceContext);
    const currentToken: string | undefined = req.cookies?.[config.auth.cookies.sessionTokenName];

    await this.authService.invalidateOtherSessions(user.id, currentToken);

    return { revokedKeys: await this.apiKeyService.revokeAllExceptConnect(user.id) };
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
   * The proof is the current password wherever the user has one they chose —
   * `passwordSetAt`, stamped by signup, by every password change and by the
   * operator scripts that set one (`make userpw`, `make testuser`). The old rule
   * exempted any account with a federated identity for good — reasonable for a
   * Portal-provisioned account holding a random password it has never seen
   * (`OidcController`, `PortalTokenService`), but it kept applying after that
   * account had chosen a password, and it asked a stolen session for nothing.
   *
   * An account with no password of its own is asked for the next best thing:
   * a session established within {@link REAUTH_SESSION_WINDOW_MS}. Sign-in time
   * survives token rotation (it is the session row's, not the token's), and a
   * caller with only an access token and no session cookie cannot prove it, so
   * they get the same answer as a stale one: 401 `REAUTH_REQUIRED`, which the
   * settings page turns into "sign in again".
   *
   * Keyed on the stamp alone, not on whether a federated identity is bound. Until
   * 2026-09-30 an account with none was asked for its password whatever the
   * stamp said, and the accounts that caught were the Hub forward-auth bridge's:
   * provisioned with a random password (`passwordChosenByUser: false`) and no
   * federated identity, so a Hub-invited person could change neither their email
   * nor their password. That makes a null stamp the whole of the exemption, so it
   * must only ever mean "nobody knows this password": anything that writes a
   * password a person knows has to stamp it. The opposite error is safe — a stamp
   * on a random password (#2743's backfill put one on every account that had no
   * federated identity, pre-federation Portal accounts and the bridge's earlier
   * ones among them) asks for a password nobody can give, never waves a caller
   * through.
   */
  private async requireReauth(user: User, currentPassword: string | undefined, req: Request): Promise<void> {
    const mustPresentPassword = Boolean(user.passwordSetAt);

    if (!mustPresentPassword) {
      const sessionToken: string | undefined = req.cookies?.[config.auth.cookies.sessionTokenName];
      const establishedAt = sessionToken
        ? await this.authService.sessionEstablishedAt(user.id, sessionToken)
        : null;

      if (!establishedAt || Date.now() - establishedAt.getTime() > REAUTH_SESSION_WINDOW_MS) {
        throw new UnauthorizedException({
          message: REAUTH_REQUIRED,
          detail: 'Log out and back in, then come back here within 10 minutes to make this change',
        });
      }

      return;
    }

    if (!currentPassword) {
      throw new BadRequestException('Current password is required');
    }

    // The same budget a sign-in spends, keyed on this account: a wrong current password is a guess at
    // the same secret. Without it, whoever held a session (a stolen token, a browser left signed in)
    // could guess the password here without limit, then change the email or the password with it.
    const { ip } = this.authService.getSessionMetadata(req);
    const throttled = this.loginThrottle.check(ip, user.email);

    if (throttled.locked) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many attempts. Please try again later.',
          retryAfterSeconds: throttled.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const validated = await this.userService.validatePassword(user.email, currentPassword);

    if (!validated) {
      this.loginThrottle.recordFailure(ip, user.email, undefined, { accountExists: true });
      throw new UnauthorizedException('Current password is incorrect');
    }

    this.loginThrottle.recordSuccess(ip, user.email);
  }
}
