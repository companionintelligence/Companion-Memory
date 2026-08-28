import { GraphIngestService } from '@ci/domains/graph';
import { CONTACT_STAGED_TYPE, SHORT_CODE_STAGED_TYPE, stagedNaturalKey } from '@ci/domains/import';

import {
  type EntityTypeAuditCandidate,
  KEYED_AS_CONTACT_SCORE,
  PHONE_SHAPED_SQL,
  UNPROVEN_KEY_SCORE,
  classifyShortCodePerson,
  withCoordinateConflict,
} from '../EntityTypeAuditService';

/**
 * The classification half, with no database anywhere near it.
 *
 * Nothing here is stubbed: `classifyShortCodePerson` calls the real
 * `isShortCode` shared with the iMessage and Google Voice parsers, the real
 * `stagedNaturalKey` that `naturalKeyFor` now delegates to, and the real
 * `GraphIngestService.linkedIdFor`. The assertions are about what those
 * produce together, which is the thing a hand-written retype migration has to
 * get right by hand.
 */
function candidate(overrides: Partial<EntityTypeAuditCandidate> = {}): EntityTypeAuditCandidate {
  const name = overrides.name ?? '262966';
  const linkedId =
    overrides.linkedId === undefined
      ? GraphIngestService.linkedIdFor(stagedNaturalKey(CONTACT_STAGED_TYPE, null, name) as string)
      : overrides.linkedId;

  return {
    entityId: '11111111-1111-4111-8111-111111111111',
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    entityType: 'Person',
    name,
    linkedTable: 'import:google_voice',
    reachableIdentifiers: 0,
    reachableProperties: false,
    ...overrides,
    linkedId,
  };
}

describe('classifyShortCodePerson', () => {
  it('proposes Concept for a short-code Person, and moves the linked_id with the type', () => {
    const finding = classifyShortCodePerson(candidate({ name: '262966' }));

    expect(finding).not.toBeNull();
    expect(finding?.proposedEntityType).toBe('Concept');
    expect(finding?.proposedNaturalKey).toBe('short_code:262966');
    // The whole reason a retype is not a one-column UPDATE: the key moves.
    expect(finding?.proposedLinkedId).toBe(GraphIngestService.linkedIdFor('short_code:262966'));
    expect(finding?.proposedLinkedId).not.toBe(candidate({ name: '262966' }).linkedId);
  });

  it('records that leaving Person strands the person search index', () => {
    expect(classifyShortCodePerson(candidate())?.searchIndexAction).toBe('purge_person_index');
  });

  it('scores a row whose key proves the pre-fix contact path above the autonomy floor', () => {
    expect(classifyShortCodePerson(candidate())?.score).toBe(KEYED_AS_CONTACT_SCORE);
    expect(KEYED_AS_CONTACT_SCORE).toBeGreaterThanOrEqual(0.7);
  });

  it('scores a row keyed some other way below it, so no trust mode may pre-authorise', () => {
    const finding = classifyShortCodePerson(candidate({ linkedId: '33333333-3333-4333-8333-333333333333' }));

    expect(finding?.score).toBe(UNPROVEN_KEY_SCORE);
    expect(UNPROVEN_KEY_SCORE).toBeLessThan(0.7);
  });

  it.each(['+1 (555) 010-9999', '5550109999', '15550109999'])(
    'leaves a Person named with a reachable number alone (%s)',
    (name) => {
      expect(classifyShortCodePerson(candidate({ name }))).toBeNull();
    },
  );

  it.each(['Adrian Kelly', 'Mom', 'alice@example.invalid'])('leaves a named Person alone (%s)', (name) => {
    expect(classifyShortCodePerson(candidate({ name }))).toBeNull();
  });

  it('refuses when an identifier says the row is reachable after all', () => {
    expect(classifyShortCodePerson(candidate({ reachableIdentifiers: 1 }))).toBeNull();
    expect(classifyShortCodePerson(candidate({ reachableProperties: true }))).toBeNull();
  });

  it('audits Person only', () => {
    expect(classifyShortCodePerson(candidate({ entityType: 'Concept' }))).toBeNull();
  });
});

describe('withCoordinateConflict', () => {
  it('is a no-op when the proposed coordinate is free', () => {
    const finding = classifyShortCodePerson(candidate()) as NonNullable<
      ReturnType<typeof classifyShortCodePerson>
    >;

    expect(withCoordinateConflict(finding, null)).toBe(finding);
  });

  it('caps a proposal whose target coordinate is taken below the autonomy floor', () => {
    const finding = classifyShortCodePerson(candidate()) as NonNullable<
      ReturnType<typeof classifyShortCodePerson>
    >;
    const occupant = '44444444-4444-4444-8444-444444444444';
    const capped = withCoordinateConflict(finding, occupant);

    expect(finding.score).toBe(KEYED_AS_CONTACT_SCORE);
    expect(capped.score).toBe(UNPROVEN_KEY_SCORE);
    expect(capped.conflictingEntityId).toBe(occupant);
    expect(capped.evidence.join('\n')).toContain('needs a merge, not a re-key');
  });
});

describe('PHONE_SHAPED_SQL', () => {
  it('names the staged types the parsers declare, so the key it builds is theirs', () => {
    expect(SHORT_CODE_STAGED_TYPE).toBe('short_code');
    expect(CONTACT_STAGED_TYPE).toBe('contact');
  });

  it('carries no digit count — the one threshold stays in isShortCode', () => {
    expect(PHONE_SHAPED_SQL).not.toMatch(/\{|\}|BETWEEN/i);
  });
});
