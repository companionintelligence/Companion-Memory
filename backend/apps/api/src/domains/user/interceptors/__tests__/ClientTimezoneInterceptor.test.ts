import type { ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';

import { CLIENT_TIMEZONE_HEADER, ClientTimezoneInterceptor } from '../ClientTimezoneInterceptor';

type FakeRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: { id: string; timezone: string };
};

function makeInterceptor() {
  const userService = { update: jest.fn().mockResolvedValue(null) };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() };

  const interceptor = new ClientTimezoneInterceptor(userService as never, logger as never);

  return { interceptor, userService, logger };
}

function httpContext(req: FakeRequest): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/**
 * The Apollo driver's default context — `{ req, res }` — reached through
 * `GqlExecutionContext`, which reads argument 3 of a resolver call.
 */
function graphqlContext(req: FakeRequest): ExecutionContext {
  const args = [undefined, {}, { req }, {}];

  return {
    getType: () => 'graphql',
    getArgs: () => args,
    getArgByIndex: (index: number) => args[index],
    // `GqlExecutionContext.create` copies these off the host before it rewrites
    // the argument accessors, so a stub without them throws.
    getClass: () => class {},
    getHandler: () => () => undefined,
  } as unknown as ExecutionContext;
}

const handler = { handle: () => of('ok') } as never;

function request(overrides: Partial<FakeRequest> = {}): FakeRequest {
  return {
    headers: { [CLIENT_TIMEZONE_HEADER]: 'America/Los_Angeles' },
    user: { id: 'user-1', timezone: 'UTC' },
    ...overrides,
  };
}

describe('ClientTimezoneInterceptor', () => {
  it('adopts the client zone for an account still on the UTC column default', async () => {
    const { interceptor, userService } = makeInterceptor();

    await interceptor.intercept(httpContext(request()), handler);

    expect(userService.update).toHaveBeenCalledWith({ userId: 'user-1' }, 'user-1', {
      timezone: 'America/Los_Angeles',
    });
  });

  /**
   * The whole safety property of this interceptor. A zone written by the FTUE
   * wizard or Settings › Preferences is a choice; a header is a guess.
   */
  it('never overwrites a stored zone that is not the UTC default', async () => {
    const { interceptor, userService } = makeInterceptor();
    const req = request({ user: { id: 'user-1', timezone: 'Europe/Berlin' } });

    await interceptor.intercept(httpContext(req), handler);

    expect(userService.update).not.toHaveBeenCalled();
    expect(req.user?.timezone).toBe('Europe/Berlin');
  });

  it('reaches the request through the GraphQL context too', async () => {
    const { interceptor, userService } = makeInterceptor();

    await interceptor.intercept(graphqlContext(request()), handler);

    expect(userService.update).toHaveBeenCalledTimes(1);
  });

  /**
   * A GraphQL document runs this interceptor once per resolved field. Without
   * the write-back onto `req.user`, every field after the first would re-issue
   * the same UPDATE — and the request that carried the header would still be
   * planning in UTC while it ran.
   */
  it('updates the resolved user in place so the same request stops asking', async () => {
    const { interceptor, userService } = makeInterceptor();
    const req = request();
    const context = graphqlContext(req);

    await interceptor.intercept(context, handler);
    await interceptor.intercept(context, handler);

    expect(req.user?.timezone).toBe('America/Los_Angeles');
    expect(userService.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no header at all', {}],
    ['an empty header', { [CLIENT_TIMEZONE_HEADER]: '   ' }],
    ['the same UTC default', { [CLIENT_TIMEZONE_HEADER]: 'UTC' }],
    ['a zone no Intl database knows', { [CLIENT_TIMEZONE_HEADER]: 'Mars/Olympus_Mons' }],
    ['something longer than any zone name', { [CLIENT_TIMEZONE_HEADER]: 'A/'.repeat(64) }],
  ])('writes nothing for %s', async (_case, headers) => {
    const { interceptor, userService } = makeInterceptor();

    await interceptor.intercept(httpContext(request({ headers })), handler);

    expect(userService.update).not.toHaveBeenCalled();
  });

  it('writes nothing for an unauthenticated request', async () => {
    const { interceptor, userService } = makeInterceptor();

    await interceptor.intercept(httpContext(request({ user: undefined })), handler);

    expect(userService.update).not.toHaveBeenCalled();
  });

  /**
   * Filling in a profile detail must never be able to fail the request that
   * happened to carry the header — this runs on EVERY authenticated request.
   */
  it('passes the request through when the write fails', async () => {
    const { interceptor, userService, logger } = makeInterceptor();

    userService.update.mockRejectedValue(new Error('database is down'));

    const result = await interceptor.intercept(httpContext(request()), handler);

    await expect(new Promise((resolve) => result.subscribe(resolve))).resolves.toBe('ok');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('ignores an execution that is neither HTTP nor GraphQL', async () => {
    const { interceptor, userService } = makeInterceptor();

    const context = { getType: () => 'rpc' } as unknown as ExecutionContext;

    await interceptor.intercept(context, handler);

    expect(userService.update).not.toHaveBeenCalled();
  });
});
