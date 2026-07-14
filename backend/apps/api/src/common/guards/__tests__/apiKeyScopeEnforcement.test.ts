import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { enforceApiKeyScopes } from '../apiKeyScopeEnforcement';
import type { ApiKeyScopedRequest } from '../apiKeyScopeEnforcement';

/**
 * Unit tests for the deny-by-default scope enforcement run inside the api-key
 * guards. Unlike the old opt-in model (allow unless a required scope is
 * missing), this DENIES a scope-limited key on any route that doesn't grant one
 * of its scopes.
 */
function setup(required: string[] | undefined, apiKeyScopes: string[] | undefined) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(required),
  } as unknown as Reflector;

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;

  const request = { apiKeyScopes } as ApiKeyScopedRequest;

  return () => enforceApiKeyScopes(reflector, context, request);
}

describe('enforceApiKeyScopes', () => {
  it('allows a non-api-key principal (apiKeyScopes undefined = full authority)', () => {
    expect(setup(['memory'], undefined)).not.toThrow();
  });

  it('allows an empty-scope key (legacy / bulk importer) everywhere', () => {
    expect(setup(undefined, [])).not.toThrow();
    expect(setup(['memory'], [])).not.toThrow();
  });

  it('allows a scoped key on a route that grants a scope it holds', () => {
    expect(setup(['memory'], ['memory', 'intents'])).not.toThrow();
  });

  it('DENIES a scoped key on a route with no @RequireScopes (deny-by-default)', () => {
    // This is the crux: a memory-scoped chat-agent key hitting /graphql, /files,
    // /v1, … (none of which declare a scope) is rejected.
    expect(setup(undefined, ['memory'])).toThrow(ForbiddenException);
    expect(setup([], ['memory'])).toThrow(ForbiddenException);
  });

  it('DENIES a scoped key missing a required scope', () => {
    expect(setup(['mcp'], ['memory', 'intents'])).toThrow(ForbiddenException);
  });

  it('requires EVERY listed scope', () => {
    expect(setup(['memory', 'mcp'], ['memory'])).toThrow(/mcp/);
  });
});
