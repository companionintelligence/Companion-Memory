import { NotFoundException, type ExecutionContext } from '@nestjs/common';

import { IdFormatGuard } from '../IdFormatGuard';

/**
 * Registered as a global `APP_GUARD` (see `application.ts`), so this runs on
 * EVERY HTTP request in the app — 404ing any route param whose name ends in
 * "id" (case-insensitive) unless the value is a well-formed UUID. No test file
 * existed for it despite that blast radius. Untested before this file: the
 * graphql bypass, the no-params passthrough, and the actual UUID-format
 * rejection (including that it is scoped to `*id`-suffixed keys only, and
 * skips non-string values rather than crashing on them).
 */

function httpContext(params: Record<string, unknown> | undefined): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => (params === undefined ? {} : { params }) }),
  } as unknown as ExecutionContext;
}

function graphqlContext(): ExecutionContext {
  return {
    getType: () => 'graphql',
    // If the guard actually tried to read HTTP request params on a GraphQL
    // context it would throw here — proving the bypass happens BEFORE this
    // is ever touched.
    switchToHttp: () => {
      throw new Error('switchToHttp should never be called for a graphql context');
    },
  } as unknown as ExecutionContext;
}

const VALID_UUID_V4 = '123e4567-e89b-42d3-a456-426614174000';
// The appliance's own ids are uuid v7 (see the bulkUpsert RETURNING-clause
// comment), so a v7 id must pass too, not just v4.
const VALID_UUID_V7 = '018f4c2e-7b1a-7c3d-8a2f-1234567890ab';

describe('IdFormatGuard — non-HTTP contexts', () => {
  it('always allows a graphql context, without inspecting any request params', () => {
    const guard = new IdFormatGuard();
    expect(guard.canActivate(graphqlContext())).toBe(true);
  });
});

describe('IdFormatGuard — HTTP requests with no route params', () => {
  const guard = new IdFormatGuard();

  it('allows a request whose params object is absent', () => {
    expect(guard.canActivate(httpContext(undefined))).toBe(true);
  });

  it('allows a request with an empty params object', () => {
    expect(guard.canActivate(httpContext({}))).toBe(true);
  });
});

describe('IdFormatGuard — UUID enforcement on *id-suffixed params', () => {
  const guard = new IdFormatGuard();

  it('allows a well-formed v4 UUID on an "id" param', () => {
    expect(guard.canActivate(httpContext({ id: VALID_UUID_V4 }))).toBe(true);
  });

  it("allows a well-formed v7 UUID (the appliance's own id format)", () => {
    expect(guard.canActivate(httpContext({ id: VALID_UUID_V7 }))).toBe(true);
  });

  it('matches the suffix case-insensitively (userId, entityID, ID, ...)', () => {
    expect(guard.canActivate(httpContext({ userId: VALID_UUID_V4 }))).toBe(true);
    expect(guard.canActivate(httpContext({ entityID: VALID_UUID_V4 }))).toBe(true);
    expect(guard.canActivate(httpContext({ ID: VALID_UUID_V4 }))).toBe(true);

    expect(() => guard.canActivate(httpContext({ userId: 'not-a-uuid' }))).toThrow(NotFoundException);
    expect(() => guard.canActivate(httpContext({ entityID: 'not-a-uuid' }))).toThrow(NotFoundException);
  });

  it('throws NotFoundException (never a raw error) for a malformed id value', () => {
    expect(() => guard.canActivate(httpContext({ id: 'not-a-uuid' }))).toThrow(NotFoundException);
    expect(() => guard.canActivate(httpContext({ id: '12345' }))).toThrow(NotFoundException);
    expect(() => guard.canActivate(httpContext({ id: '' }))).toThrow(NotFoundException);
  });

  it('allows any UUID shape, whatever its version and variant nibbles', () => {
    // Version 1, and the two seeded provider ids that used to 404: Slack's
    // variant nibble is 'c', Signal's version nibble is '8'.
    expect(guard.canActivate(httpContext({ id: '123e4567-e89b-12d3-a456-426614174000' }))).toBe(true);
    expect(guard.canActivate(httpContext({ id: '019e3c66-b5d2-7f03-c9e5-1a4f6b9d0c08' }))).toBe(true);
    expect(guard.canActivate(httpContext({ id: '019e3d77-c6e3-8f14-da06-2b5f7c0e1d19' }))).toBe(true);
  });

  it('rejects a value that is UUID-length but not hex, or has the dashes in the wrong place', () => {
    expect(() => guard.canActivate(httpContext({ id: '123e4567-e89b-12d3-a456-42661417400g' }))).toThrow(
      NotFoundException,
    );
    expect(() => guard.canActivate(httpContext({ id: '123e4567e-89b-12d3-a456-426614174000' }))).toThrow(
      NotFoundException,
    );
  });

  it('ignores params whose name does NOT end in "id"', () => {
    expect(guard.canActivate(httpContext({ name: 'not-a-uuid-and-thats-fine' }))).toBe(true);
  });

  it('skips a non-string value for an id-suffixed param rather than throwing', () => {
    expect(guard.canActivate(httpContext({ id: 42 }))).toBe(true);
    expect(guard.canActivate(httpContext({ id: null }))).toBe(true);
  });

  it('checks every id-suffixed param, not just the first, and rejects if ANY is malformed', () => {
    expect(() => guard.canActivate(httpContext({ userId: VALID_UUID_V4, orderId: 'garbage' }))).toThrow(
      NotFoundException,
    );
  });

  it('allows a request whose only params are non-id and a well-formed id together', () => {
    expect(guard.canActivate(httpContext({ userId: VALID_UUID_V4, sortBy: 'createdAt' }))).toBe(true);
  });
});
