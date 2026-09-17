import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import type { Request } from 'express';
import { Observable } from 'rxjs';

import { LoggerService } from '@ci/common/logging';
import { isValidTimezone } from '@ci/common/time/zoned';

import { UserService } from '../services/UserService';

/**
 * Header a client sets to its own `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 * Lower-case because Node normalises incoming header names.
 */
export const CLIENT_TIMEZONE_HEADER = 'x-client-timezone';

/**
 * The `ci.users.timezone` column default. A row still holding it has never had a
 * zone written to it by anybody.
 */
const UNSET_TIMEZONE = 'UTC';

/** No IANA zone name is anywhere near this long; anything longer is not one. */
const MAX_TIMEZONE_LENGTH = 64;

/**
 * The GraphQL context object the Apollo driver builds. It is not configured in
 * `domains/graphql`, so it is the driver's default — `{ req, res }`.
 */
type GraphQLContext = { req?: Request };

/** The mutable view of `req.user`; the egress `User` type is `Readonly`. */
type RequestUser = { id?: string; timezone?: string };

/**
 * Adopts the client's IANA zone onto an account that has never had one.
 *
 * ═══ WHY THIS EXISTS AT ALL ═══
 *
 * `ci.users.timezone` is the single source of truth for "the user's day" —
 * `PlanningTimeService` builds every workday window from it — but until this
 * interceptor the FTUE wizard and Settings were its ONLY writers. Every account
 * created any other way (`scripts/seed-database`, `create-test-user.ts`, a
 * CI-Portal OIDC first login, a plain signup) sat on the 'UTC' default forever,
 * and the seeder and test-user script both flag the account onboarded, so
 * nothing would ever prompt for it. The planner then places a Los Angeles
 * owner's work across 02:00–10:00 local and stamps `scheduled_for` off the
 * wrong local date near midnight.
 *
 * Doing it here rather than at each `userService.create` call site covers all
 * four creation paths plus the two scripts without a fifth `create()` signature,
 * and it is the earliest point in the request lifecycle where the identity is
 * known: guards (and therefore Passport) have run, so `req.user` is populated.
 *
 * ═══ WHAT IT WILL NOT DO ═══
 *
 * Overwrite a zone the user chose. The write is gated on the stored value still
 * being the untouched column default, so Settings › Preferences and the FTUE
 * wizard always win. The one case that cannot be told apart is a user who
 * deliberately chose UTC in Settings — 'UTC' as a choice is indistinguishable
 * from 'UTC' as a column default until `ci.users` carries a "who set this"
 * marker. The header is otherwise treated as untrusted input: length-capped and
 * checked against the platform Intl database before it is written.
 */
@Injectable()
export class ClientTimezoneInterceptor implements NestInterceptor {
  constructor(
    private readonly userService: UserService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ClientTimezoneInterceptor.name);
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    await this.adopt(requestOf(context));

    return next.handle();
  }

  private async adopt(req: Request | undefined): Promise<void> {
    if (req == null) {
      return;
    }

    const user = req.user as RequestUser | undefined;

    if (user?.id == null || user.timezone !== UNSET_TIMEZONE) {
      return;
    }

    const claimed = claimedTimezone(req);

    if (claimed == null) {
      return;
    }

    try {
      await this.userService.update({ userId: user.id }, user.id, { timezone: claimed });

      // Mutating the resolved user is not bookkeeping: the request this rode in
      // on reads its zone from here, so without it the very first Plan query
      // still plans in UTC — and, on a GraphQL document, every remaining field
      // resolver would repeat the write.
      user.timezone = claimed;

      this.logger.log('Adopted client timezone for an account still on the UTC default', {
        userId: user.id,
        timezone: claimed,
      });
    } catch (err) {
      // Filling in a profile detail is never worth failing the request that
      // happened to carry it.
      this.logger.warn('Could not persist client timezone', {
        userId: user.id,
        timezone: claimed,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * A GraphQL execution is not an HTTP execution as far as `ExecutionContext` is
 * concerned: `switchToHttp().getRequest()` there returns the resolver's parent
 * object, not a request. So the type has to be branched on rather than assumed.
 */
function requestOf(context: ExecutionContext): Request | undefined {
  const type = context.getType<GqlContextType>();

  if (type === 'http') {
    return context.switchToHttp().getRequest<Request>();
  }

  if (type === 'graphql') {
    return GqlExecutionContext.create(context).getContext<GraphQLContext>().req;
  }

  return undefined;
}

/** The header's zone, or undefined when it is absent, oversized, UTC or not a zone. */
function claimedTimezone(req: Request): string | undefined {
  const raw = req.headers[CLIENT_TIMEZONE_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();

  if (!value || value.length > MAX_TIMEZONE_LENGTH || value === UNSET_TIMEZONE) {
    return undefined;
  }

  return isValidTimezone(value) ? value : undefined;
}
