import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import type { ApiKeyCapability } from '@ci/common/decorators';

import { enforceApiKeyCapability, enforceApiKeyScopes } from '../apiKeyScopeEnforcement';
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

/**
 * Capability enforcement — the second axis, run from the same guards.
 *
 * Without it the two axes only met on the MCP tool surface, so a read-only key carrying `memory`
 * could still POST /api/memory/write. That is worse than not offering read-only at all: the
 * settings UI has already told the user the key cannot record anything.
 */
type Shape =
  { type: 'http'; method: string } | { type: 'graphql'; operation: 'query' | 'mutation' | 'subscription' };

/**
 * `shape` is what the request looks like when the route declares nothing — the
 * HTTP verb, or the GraphQL operation kind (mocked the way GqlExecutionContext
 * reads it: `getArgs()[3]` is the resolver `info` argument). The default is a
 * GET so the pre-existing cases, which only exercise the declared level, are
 * shape-neutral.
 */
function setupCapability(
  required: ApiKeyCapability | undefined,
  request: Partial<ApiKeyScopedRequest>,
  shape: Shape = { type: 'http', method: 'GET' },
) {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(required),
  } as unknown as Reflector;
  const info = shape.type === 'graphql' ? { operation: { operation: shape.operation } } : undefined;

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    getType: () => shape.type,
    getArgs: () => [undefined, undefined, undefined, info],
    getArgByIndex: (index: number) => [undefined, undefined, undefined, info][index],
  } as unknown as ExecutionContext;
  const req = { ...request, method: shape.type === 'http' ? shape.method : 'POST' };

  return () => enforceApiKeyCapability(reflector, context, req as ApiKeyScopedRequest);
}

describe('enforceApiKeyCapability', () => {
  it('allows a non-api-key principal (a session IS the user)', () => {
    expect(setupCapability('full', { apiKeyScopes: undefined })).not.toThrow();
  });

  describe('a route that declares nothing requires what its shape implies', () => {
    const readKey = { apiKeyScopes: [], apiKeyCapability: 'read' as const };
    const writeKey = { apiKeyScopes: [], apiKeyCapability: 'write' as const };

    it('GraphQL: a query is a read, a mutation is a write', () => {
      expect(setupCapability(undefined, readKey, { type: 'graphql', operation: 'query' })).not.toThrow();
      // The hole this closes: 140 mutations declared nothing, so a "read-only" key ran them all.
      expect(setupCapability(undefined, readKey, { type: 'graphql', operation: 'mutation' })).toThrow(
        /is "read".*requires "write"/,
      );
      expect(setupCapability(undefined, writeKey, { type: 'graphql', operation: 'mutation' })).not.toThrow();
      // A subscription opens a stream the server pushes into — treated as a write, conservatively.
      expect(setupCapability(undefined, readKey, { type: 'graphql', operation: 'subscription' })).toThrow(
        ForbiddenException,
      );
    });

    it('REST: GET/HEAD/OPTIONS are reads, every other verb is a write', () => {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        expect(setupCapability(undefined, readKey, { type: 'http', method })).not.toThrow();
      }

      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        expect(setupCapability(undefined, readKey, { type: 'http', method })).toThrow(ForbiddenException);
        expect(setupCapability(undefined, writeKey, { type: 'http', method })).not.toThrow();
      }
    });

    it('a declared level overrides the shape in either direction', () => {
      // Down: a POST that only computes (e.g. /llm/generate) says so and admits a read key.
      expect(setupCapability('read', readKey, { type: 'http', method: 'POST' })).not.toThrow();
      // Up: a GET that is really an operator action can demand full.
      expect(setupCapability('full', writeKey, { type: 'http', method: 'GET' })).toThrow(ForbiddenException);
    });

    it('never applies to a session or Portal principal', () => {
      expect(
        setupCapability(undefined, { apiKeyScopes: undefined }, { type: 'graphql', operation: 'mutation' }),
      ).not.toThrow();
    });
  });

  it('lets a key act at or above the level a route requires', () => {
    expect(setupCapability('read', { apiKeyScopes: ['memory'], apiKeyCapability: 'read' })).not.toThrow();
    expect(setupCapability('read', { apiKeyScopes: ['memory'], apiKeyCapability: 'full' })).not.toThrow();
    expect(setupCapability('write', { apiKeyScopes: ['memory'], apiKeyCapability: 'write' })).not.toThrow();
  });

  it('DENIES a read-only key on a route that writes', () => {
    expect(setupCapability('write', { apiKeyScopes: ['memory'], apiKeyCapability: 'read' })).toThrow(
      ForbiddenException,
    );
  });

  it('names both levels in the refusal, so the fix is obvious from the error', () => {
    expect(setupCapability('write', { apiKeyScopes: ['memory'], apiKeyCapability: 'read' })).toThrow(
      /is "read".*requires "write"/,
    );
  });

  it('applies to an empty-scope (full-surface) key too', () => {
    // "Reaches every surface" and "may write on it" are separate grants — the bulk importer is
    // exactly the credential that should be able to write without being able to delete.
    expect(setupCapability('write', { apiKeyScopes: [], apiKeyCapability: 'read' })).toThrow(
      ForbiddenException,
    );
    expect(setupCapability('full', { apiKeyScopes: [], apiKeyCapability: 'write' })).toThrow(
      ForbiddenException,
    );
  });

  it('treats an api-key request carrying no capability as read-only', () => {
    // ApiKeyStrategy always sets it, so its absence means the request did not come through the
    // strategy — and an unknown caller gets the least authority, not the most.
    expect(setupCapability('write', { apiKeyScopes: ['memory'] })).toThrow(ForbiddenException);
    expect(setupCapability('read', { apiKeyScopes: ['memory'] })).not.toThrow();
  });
});
