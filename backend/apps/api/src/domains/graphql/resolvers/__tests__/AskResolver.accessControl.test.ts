import { GUARDS_METADATA } from '@nestjs/common/constants';

import { type RequestContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';

import { AskResolver } from '../AskResolver';

/**
 * ═══ THE GUARD ON THE ASKS SURFACE WAS PINNED BY NOTHING ═══
 *
 * `@UseGuards(JwtOrApiKeyAuthGuard)` on {@link AskResolver} is the only thing
 * standing between an unauthenticated request and a surface whose whole job is
 * disclosing one person's memory to another person. Deleting that one line
 * changed no test in the suite: every existing test constructs the resolver
 * directly and hands it a context, which is precisely the path a guard does not
 * sit on.
 *
 * The class-level guard is also what makes `toServiceContext(context)` safe
 * everywhere below it — every mutation and query in this resolver reads the
 * caller's identity out of a context the guard is responsible for populating,
 * and an unguarded resolver would be reading whatever the request carried.
 *
 * MUTATION-TESTED: remove the decorator and this suite goes red.
 */
describe('the Asks GraphQL surface is signed-in only', () => {
  it('carries the auth guard at CLASS level, so it covers every operation', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AskResolver) as unknown[] | undefined;

    expect(guards).toBeDefined();
    expect(guards).toContain(JwtOrApiKeyAuthGuard);
  });

  /**
   * Class level, not per-method. A guard applied operation by operation is one
   * `@Mutation` away from a hole, and the hole is invisible: an unguarded
   * mutation behaves identically for an authenticated caller.
   */
  it.each([
    'createAsk',
    'approveAsk',
    'declineAsk',
    'runAsk',
    'sendPeerAsk',
    'createAskGrant',
    'updateAskGrant',
    'revokeAskGrant',
    'ask',
    'askAnswer',
    'askInbox',
    'askOutbox',
    'myAskGrants',
    'myAskGrantHistory',
    'askGrant',
    'askDisclosureHistory',
  ])('covers %s', (operation) => {
    // Every operation named here exists (a rename must not silently drop one
    // out of this list) and inherits the class guard, because none of them
    // declares its own.
    const method = (AskResolver.prototype as unknown as Record<string, unknown>)[operation];
    expect(typeof method).toBe('function');

    const classGuards = Reflect.getMetadata(GUARDS_METADATA, AskResolver) as unknown[];
    expect(classGuards).toContain(JwtOrApiKeyAuthGuard);
  });
});

/**
 * The disclosure history is the owner's record of what left their box. It is
 * scoped in exactly one place — `AskAuditService.listForResponder`'s
 * `where: { responderUserId: context.userId }` — and the resolver's only job is
 * to hand it the CALLER's context rather than anything else.
 *
 * Pinned here at the resolver, and against real Postgres in
 * `asks/services/__tests__/AskDeadlineAndScope.integration.spec.ts`, because a
 * mock can show the context is forwarded and only a real query can show the
 * WHERE clause excludes the other person's rows.
 */
describe('askDisclosureHistory is scoped to the caller', () => {
  it('passes the CALLER’s context to the audit service, not a bare or borrowed one', async () => {
    const auditService = { listForResponder: jest.fn().mockResolvedValue({ rows: [], truncated: false }) };
    const resolver = new AskResolver(
      {} as never,
      {} as never,
      auditService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never,
    );

    await resolver.askDisclosureHistory({ userId: 'responder-1' } as unknown as RequestContext);

    // The responder scope is the FIRST argument and does not depend on the
    // filter — a filter can only ever narrow within it.
    const [scope, filter] = auditService.listForResponder.mock.calls[0];
    expect(scope).toEqual({ userId: 'responder-1' });

    // With no input, the filter narrows on nothing: no counterparty clause is
    // even present, so it cannot be the thing that scopes the read.
    expect(filter).not.toHaveProperty('askerUserId');
    expect(filter).not.toHaveProperty('peerLinkId');
  });

  it('reads nothing at all while the feature flag is off', async () => {
    const auditService = { listForResponder: jest.fn() };
    const resolver = new AskResolver(
      {} as never,
      {} as never,
      auditService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { isFeatureEnabled: jest.fn().mockResolvedValue(false) } as never,
    );

    expect(
      await resolver.askDisclosureHistory({ userId: 'responder-1' } as unknown as RequestContext),
    ).toEqual({ rows: [], truncated: false });
    expect(auditService.listForResponder).not.toHaveBeenCalled();
  });
});
