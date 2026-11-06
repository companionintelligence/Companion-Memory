import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { printSchema, type GraphQLSchema } from 'graphql';

import { FULL_CAPABILITY, READ_CAPABILITY } from '@ci/common/decorators';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { GRAPHQL_PRIVACY_EXTENSION, PendingActionService, type IntentPrivacy } from '@ci/domains/tools';

import { LocalPubPeerResolver } from '../LocalPubPeerResolver';

const CANDIDATE = {
  handle: 'alice@alice.example',
  actorId: 'https://alice.example/actor',
  profileUrl: 'https://alice.example/',
  displayName: 'Alice Example',
  claimedDids: [],
  companionEndpoint: 'https://m.alice.example/agent/v1',
  companionDidKey: null,
};

function makeResolver(opts: { lookup?: unknown; feature?: boolean | null } = {}) {
  const discovery = {
    lookup: jest.fn().mockResolvedValue(opts.lookup ?? { ok: true, candidate: CANDIDATE }),
  };
  const featureService =
    opts.feature === null
      ? undefined
      : { isFeatureEnabled: jest.fn().mockResolvedValue(opts.feature ?? true) };
  const resolver = new LocalPubPeerResolver(discovery as never, featureService as never);

  return { resolver, discovery, featureService };
}

describe('LocalPubPeerResolver.localPubPeerLookup', () => {
  it('returns the candidate a profile claims, and nothing else', async () => {
    const { resolver, discovery } = makeResolver();

    await expect(resolver.localPubPeerLookup('@alice@alice.example')).resolves.toEqual({
      found: true,
      reason: null,
      candidate: CANDIDATE,
    });
    expect(discovery.lookup).toHaveBeenCalledWith('@alice@alice.example');
  });

  it.each([
    'disabled',
    'bad-handle',
    'blocked',
    'redirected',
    'not-found',
    'bad-response',
    'unreachable',
    'busy',
  ])('reports %s as a reason, with no candidate', async (reason) => {
    const { resolver } = makeResolver({ lookup: { ok: false, reason } });

    await expect(resolver.localPubPeerLookup('alice@alice.example')).resolves.toEqual({
      found: false,
      reason,
      candidate: null,
    });
  });

  it('asks the ask feature flag, by that name, before it looks anyone up', async () => {
    const { resolver, featureService } = makeResolver();

    await resolver.localPubPeerLookup('alice@alice.example');

    expect(featureService?.isFeatureEnabled).toHaveBeenCalledTimes(1);
    expect(featureService?.isFeatureEnabled).toHaveBeenCalledWith('ask');
  });

  it('does not look anyone up while the ask feature is off', async () => {
    const { resolver, discovery } = makeResolver({ feature: false });

    await expect(resolver.localPubPeerLookup('alice@alice.example')).resolves.toEqual({
      found: false,
      reason: 'disabled',
      candidate: null,
    });
    expect(discovery.lookup).not.toHaveBeenCalled();
  });

  it('works where the feature service is not provided', async () => {
    const { resolver } = makeResolver({ feature: null });

    await expect(resolver.localPubPeerLookup('alice@alice.example')).resolves.toMatchObject({ found: true });
  });
});

/**
 * ═══ THE GUARD IS THE ONLY AUTHENTICATION ON THIS FIELD ═══
 *
 * `@UseGuards(JwtOrApiKeyAuthGuard)` is all that stands between an anonymous caller and a box that
 * will open connections to a host the caller names (the sole global guard only checks id formats).
 * Constructing the resolver directly, as the tests above do, never touches a guard, so deleting the
 * decorator changed no test. Same pin as `AskResolver.accessControl.test.ts`.
 *
 * MUTATION-TESTED: remove the decorator and this test goes red.
 */
describe('the Local.Pub lookup is signed-in only', () => {
  it('carries the auth guard at class level, so it covers every field on it', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, LocalPubPeerResolver) as unknown[] | undefined;

    expect(guards).toBeDefined();
    expect(guards).toContain(JwtOrApiKeyAuthGuard);
  });
});

describe('the localPubPeerLookup field, in the real schema', () => {
  let schema: GraphQLSchema;

  beforeAll(async () => {
    const app = await NestFactory.create(GraphQLSchemaBuilderModule, { logger: false });

    await app.init();
    schema = await app.get(GraphQLSchemaFactory).create([LocalPubPeerResolver]);
    await app.close();
  });

  it('is a query, labelled as an external read', () => {
    const field = schema.getQueryType()?.getFields().localPubPeerLookup;

    expect(field).toBeDefined();
    expect(field?.extensions?.[GRAPHQL_PRIVACY_EXTENSION] as Partial<IntentPrivacy>).toEqual({
      access: 'read',
      external: true,
    });
  });

  it('takes one required handle and returns the payload with a nullable candidate', () => {
    const sdl = printSchema(schema);

    expect(sdl).toContain('localPubPeerLookup(handle: String!): LocalPubPeerLookupPayload!');
    expect(sdl).toMatch(
      /type LocalPubPeerLookupPayload \{[^}]*found: Boolean![^}]*candidate: LocalPubPeerCandidateType[^!]/s,
    );
  });

  it('describes the candidate as claims: a Companion address and did:key, DIDs for display, no key list', () => {
    const type = schema.getType('LocalPubPeerCandidateType');
    const fields = Object.keys((type as unknown as { getFields(): Record<string, unknown> }).getFields());

    expect(fields.sort()).toEqual(
      [
        'actorId',
        'claimedDids',
        'companionDidKey',
        'companionEndpoint',
        'displayName',
        'handle',
        'profileUrl',
      ].sort(),
    );
    expect(schema.getType('LocalPubPeerKeyType')).toBeUndefined();
  });
});

/**
 * ═══ WHAT THE TRUST GATE ACTUALLY DOES WITH THIS FIELD'S LABEL ═══
 *
 * Every root Query is an MCP tool, and the lookup reaches a host the caller named. The documents say
 * what the gate does with an `{ access: 'read', external: true }` label; this runs the REAL
 * `PendingActionService.evaluate` for each dial and caller so those sentences cannot drift from the
 * policy. The policy is the repo's own (an external read changes nothing and sends nothing as the
 * owner, so it runs unattended under the default dial); it is pinned here, not chosen here.
 */
describe('the trust gate, for the label this field carries', () => {
  const intent = {
    name: 'query_localPubPeerLookup',
    domain: 'graphql',
    title: 'localPubPeerLookup',
    description: 'localPubPeerLookup',
    parameters: {},
    localCapable: false,
    privacy: { access: 'read', sensitivity: 'personal', destructive: false, external: true },
  };

  const service = (trustMode: string) =>
    new PendingActionService(
      { create: jest.fn(), save: jest.fn(), findOne: jest.fn(), find: jest.fn(async () => []) } as never,
      { getProfile: jest.fn(async () => ({ trustMode })) } as never,
      { isFeatureEnabled: jest.fn(async () => true) } as never,
      { setContext: jest.fn(), debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    );

  it.each([
    ['hands_off', 'execute'],
    ['balanced', 'execute'],
    ['cautious', 'queue'],
  ])("under the %s dial an owner's call %ss", async (trustMode, expected) => {
    const ruling = await service(trustMode).evaluate(intent as never, {
      userId: 'user-1',
      capability: READ_CAPABILITY,
    });

    expect(ruling.decision).toBe(expected);
  });

  it.each([
    ['hands_off', 'queue'],
    ['balanced', 'queue'],
    ['cautious', 'queue'],
  ])("under the %s dial a connected (managed) app's call is held", async (trustMode, expected) => {
    const ruling = await service(trustMode).evaluate(
      intent as never,
      {
        userId: 'user-1',
        capability: FULL_CAPABILITY,
        principal: 'managed-app',
      } as never,
    );

    expect(ruling.decision).toBe(expected);
  });
});
