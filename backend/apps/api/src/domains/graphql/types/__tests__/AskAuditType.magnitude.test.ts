import { type AskAudit } from '@ci/domains/asks';

import { AskAuditType } from '../AskType';

/**
 * The Disclosure History is the owner's receipt. It could show WHICH references
 * were disclosed and never HOW MANY items were — and only the `retrieval` form
 * has references at all, so every other form rendered as an empty disclosure
 * while a real magnitude had crossed to the asker.
 *
 * `askDisclosureHistory` is responder-scoped (`listForResponder`), so unlike
 * `AskAnswerType` — which zeroes the count for a non-itemizing form so the
 * asker cannot use it as an oracle — this projection carries the TRUE number.
 */

function fakeAudit(overrides: Partial<AskAudit> = {}): AskAudit {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    askId: '018f0000-0000-7000-8000-000000000002',
    askerUserId: '018f0000-0000-7000-8000-000000000003',
    peerLinkId: null,
    peerHandle: null,
    responderUserId: '018f0000-0000-7000-8000-000000000004',
    query: { queryType: 'photos', prompt: 'how many photos of us do you have?' },
    consentBasis: 'grant-auto',
    outcome: 'answered',
    disclosedEntities: [],
    disclosedCount: 4,
    backingEntities: ['e1', 'e2', 'e3', 'e4', 'e5'],
    createdAt: new Date('2026-08-20T00:00:00Z'),
    ...overrides,
  } as AskAudit;
}

describe('AskAuditType — the owner’s history shows HOW MUCH crossed', () => {
  it('exposes the disclosed count for a non-itemizing form', () => {
    expect(AskAuditType.toType(fakeAudit()).disclosedCount).toBe(4);
  });

  it('shows zero for the outcomes that disclosed nothing', () => {
    for (const outcome of ['declined', 'expired'] as const) {
      const projected = AskAuditType.toType(fakeAudit({ outcome, disclosedCount: 0 }));

      expect(projected.disclosedCount).toBe(0);
      expect(projected.outcome).toBe(outcome);
    }
  });

  it('does not narrow it the way the ASKER-facing answer projection does', () => {
    // The two projections have opposite jobs. `AskAnswerType` zeroes a
    // non-itemizing count so the asker cannot turn it into a count oracle over
    // the owner's corpus; this one is the owner reading their own receipt.
    expect(AskAuditType.toType(fakeAudit({ disclosedCount: 9 })).disclosedCount).toBe(9);
  });
});
