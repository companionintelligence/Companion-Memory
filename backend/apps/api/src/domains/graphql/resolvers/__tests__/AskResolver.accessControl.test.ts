import { GUARDS_METADATA } from '@nestjs/common/constants';

import { type RequestContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import {
  ISO_27560_DPV_SCHEMA_VERSION,
  type Iso27560ConsentReceipt,
  verifyIso27560ConsentReceipt,
} from '@ci/domains/asks';

import { GlobalUID } from '../../types/GlobalUID';
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
    'askAuditReceipt',
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
      {
        // The household-tier service. `resolveTier` consults it for a LOCAL
        // asker; undefined member means the default (`household`) still applies.
        tierFor: jest.fn().mockResolvedValue('household'),
        listForOwner: jest.fn().mockResolvedValue([]),
        setTier: jest.fn(),
      } as never,
      {
        // The broadcast service. `createAskBroadcast` / `myAskBroadcasts` are the
        // only callers; every other operation here never touches it.
        create: jest.fn(),
        listForAsker: jest.fn().mockResolvedValue([]),
        asksForBroadcasts: jest.fn().mockResolvedValue(new Map()),
        findForAsker: jest.fn(),
      } as never,
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
      {
        // The household-tier service. `resolveTier` consults it for a LOCAL
        // asker; undefined member means the default (`household`) still applies.
        tierFor: jest.fn().mockResolvedValue('household'),
        listForOwner: jest.fn().mockResolvedValue([]),
        setTier: jest.fn(),
      } as never,
      {
        // The broadcast service. `createAskBroadcast` / `myAskBroadcasts` are the
        // only callers; every other operation here never touches it.
        create: jest.fn(),
        listForAsker: jest.fn().mockResolvedValue([]),
        asksForBroadcasts: jest.fn().mockResolvedValue(new Map()),
        findForAsker: jest.fn(),
      } as never,
      { isFeatureEnabled: jest.fn().mockResolvedValue(false) } as never,
    );

    expect(
      await resolver.askDisclosureHistory({ userId: 'responder-1' } as unknown as RequestContext),
    ).toEqual({ rows: [], truncated: false });
    expect(auditService.listForResponder).not.toHaveBeenCalled();
  });
});

describe('askAuditReceipt is responder-scoped and returns verifiable ISO 27560 + SAID proofs', () => {
  it('returns null when the feature flag is off or the id is not a valid ask-audit GlobalUID', async () => {
    const findByIdForResponder = jest.fn();
    const disabledResolver = new AskResolver(
      {} as never,
      {} as never,
      { findByIdForResponder } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { tierFor: jest.fn(), listForOwner: jest.fn(), setTier: jest.fn() } as never,
      {
        create: jest.fn(),
        listForAsker: jest.fn(),
        asksForBroadcasts: jest.fn(),
        findForAsker: jest.fn(),
      } as never,
      { isFeatureEnabled: jest.fn().mockResolvedValue(false) } as never,
    );

    const validGlobalId = GlobalUID.encode('ask-audit', '11111111-1111-4111-8111-111111111111');
    expect(
      await disabledResolver.askAuditReceipt(
        { userId: 'responder-1' } as unknown as RequestContext,
        validGlobalId,
      ),
    ).toBeNull();
    expect(findByIdForResponder).not.toHaveBeenCalled();

    const enabledResolver = new AskResolver(
      {} as never,
      {} as never,
      { findByIdForResponder } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { tierFor: jest.fn(), listForOwner: jest.fn(), setTier: jest.fn() } as never,
      {
        create: jest.fn(),
        listForAsker: jest.fn(),
        asksForBroadcasts: jest.fn(),
        findForAsker: jest.fn(),
      } as never,
      { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never,
    );

    expect(
      await enabledResolver.askAuditReceipt(
        { userId: 'responder-1' } as unknown as RequestContext,
        GlobalUID.encode('ask', '11111111-1111-4111-8111-111111111111'),
      ),
    ).toBeNull();
    expect(
      await enabledResolver.askAuditReceipt(
        { userId: 'responder-1' } as unknown as RequestContext,
        'not-base64-id!',
      ),
    ).toBeNull();
    expect(findByIdForResponder).not.toHaveBeenCalled();
  });

  it('decodes the GlobalUID, scopes lookup to the caller, and builds a verifiable ISO 27560 receipt', async () => {
    const rawAuditId = '11111111-1111-4111-8111-111111111111';
    const rawAskId = '22222222-2222-4222-8222-222222222222';
    const findByIdForResponder = jest.fn().mockResolvedValue({
      id: rawAuditId,
      askId: rawAskId,
      askerUserId: 'asker-1',
      peerLinkId: null,
      peerHandle: 'alice@example.ts.net',
      responderUserId: 'responder-1',
      query: { queryType: 'photos', prompt: 'recent trip' },
      disclosedEntities: ['entity-1'],
      disclosedCount: 1,
      consentBasis: 'owner_approved',
      outcome: 'answered',
      createdAt: new Date('2026-11-12T10:00:00Z'),
    });

    const resolver = new AskResolver(
      {} as never,
      {} as never,
      { findByIdForResponder } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { tierFor: jest.fn(), listForOwner: jest.fn(), setTier: jest.fn() } as never,
      {
        create: jest.fn(),
        listForAsker: jest.fn(),
        asksForBroadcasts: jest.fn(),
        findForAsker: jest.fn(),
      } as never,
      { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as never,
    );

    const payload = await resolver.askAuditReceipt(
      { userId: 'responder-1' } as unknown as RequestContext,
      GlobalUID.encode('ask-audit', rawAuditId),
    );

    expect(findByIdForResponder).toHaveBeenCalledWith({ userId: 'responder-1' }, rawAuditId);
    expect(payload).not.toBeNull();
    expect(payload?.auditId).toBe(GlobalUID.encode('ask-audit', rawAuditId));
    expect(payload?.askId).toBe(GlobalUID.encode('ask', rawAskId));
    expect(payload?.auditSaid).toMatch(/^I[A-Za-z0-9_-]{43}$/);
    expect(payload?.receipt.d).toMatch(/^I[A-Za-z0-9_-]{43}$/);
    expect(payload?.receipt.schemaVersion).toBe('iso-27560:2023+dpv:v2');
    expect(payload?.receipt.schemaVersion).toBe(ISO_27560_DPV_SCHEMA_VERSION);
    expect(payload?.receipt.legalBasis).toBe('dpv:ExplicitConsent');
    expect(verifyIso27560ConsentReceipt(payload!.receipt as unknown as Iso27560ConsentReceipt)).toBe(true);
  });
});
