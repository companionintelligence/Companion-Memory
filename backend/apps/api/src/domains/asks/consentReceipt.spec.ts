import {
  buildIso27560ConsentReceipt,
  ISO_27560_DPV_SCHEMA_VERSION,
  verifyIso27560ConsentReceipt,
} from './consentReceipt';
import type { RecordAskAuditDto } from './types';

describe('consentReceipt (ISO/IEC TS 27560 + DPV v2)', () => {
  const baseInput: RecordAskAuditDto = {
    askId: 'ask-consent-1',
    askerUserId: 'asker-1',
    responderUserId: 'responder-1',
    peerHandle: 'alice@example.ts.net',
    query: { queryType: 'memory', prompt: 'Where did we meet?' },
    consentBasis: 'owner_approved',
    outcome: 'answered',
    disclosedEntities: ['entity-1', 'entity-2'],
    disclosedCount: 2,
  };

  it('maps owner_approved to dpv:ExplicitConsent and DPV processing actions', () => {
    const receipt = buildIso27560ConsentReceipt(baseInput, {
      issuedAt: '2026-11-12T00:00:00.000Z',
    });

    expect(receipt.schemaVersion).toBe(ISO_27560_DPV_SCHEMA_VERSION);
    expect(receipt.legalBasis).toBe('dpv:ExplicitConsent');
    expect(receipt.purposes).toEqual(['dpv:RequestedServiceProvision', 'dpv:ServiceProvision']);
    expect(receipt.processing).toEqual(['dpv:Disclose', 'dpv:Share']);
    expect(receipt.d).toMatch(/^I[A-Za-z0-9_-]{43}$/);
    expect(verifyIso27560ConsentReceipt(receipt)).toBe(true);
  });

  it('maps non-disclosure outcomes to dpv:Assess and consent basis strings to DPV purposes', () => {
    const personalReceipt = buildIso27560ConsentReceipt({
      ...baseInput,
      consentBasis: 'standing_grant',
      disclosedEntities: [],
      disclosedCount: 0,
    });
    expect(personalReceipt.legalBasis).toBe('dpv:Consent');
    expect(personalReceipt.purposes).toEqual(['dpv:PersonalisedBenefits', 'dpv:ServiceProvision']);
    expect(personalReceipt.processing).toEqual(['dpv:Assess']);
    expect(verifyIso27560ConsentReceipt(personalReceipt)).toBe(true);

    const peerReceipt = buildIso27560ConsentReceipt({
      ...baseInput,
      consentBasis: 'peer_transfer',
      disclosedEntities: [],
      disclosedCount: 1,
    });
    expect(peerReceipt.purposes).toContain('dpv:DataTransfer');
    expect(peerReceipt.processing).toEqual(['dpv:Disclose', 'dpv:Share']);
    expect(verifyIso27560ConsentReceipt(peerReceipt)).toBe(true);

    const emptyBasisReceipt = buildIso27560ConsentReceipt({
      ...baseInput,
      consentBasis: null,
    });
    expect(emptyBasisReceipt.purposes).toEqual(['dpv:ServiceProvision']);
    expect(verifyIso27560ConsentReceipt(emptyBasisReceipt)).toBe(true);
  });

  it('detects tampering of any signed field or malformed SAID', () => {
    const receipt = buildIso27560ConsentReceipt(baseInput, {
      issuedAt: '2026-11-12T00:00:00.000Z',
    });

    expect(verifyIso27560ConsentReceipt({ ...receipt, outcome: 'declined' })).toBe(false);
    expect(verifyIso27560ConsentReceipt({ ...receipt, legalBasis: 'dpv:Consent' })).toBe(false);
    expect(verifyIso27560ConsentReceipt({ ...receipt, purposes: ['dpv:ServiceProvision'] })).toBe(false);
    expect(verifyIso27560ConsentReceipt({ ...receipt, d: 'invalid-said' })).toBe(false);
  });
});
