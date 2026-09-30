import { describe, expect, it } from 'vitest';

import {
  formatPhoneNumber,
  groupMergeCandidates,
  humanReason,
  sharedPhoneNumbers,
  type MergeCandidate,
} from './PeopleMergeCards';

type Evidence = MergeCandidate['evidence'];

function evidence(...items: Array<[kind: string, value: string, score: number | null]>): Evidence {
  return items.map(([kind, value, score]) => ({
    __typename: 'MergeCandidateEvidenceType' as const,
    kind,
    value,
    score,
  }));
}

describe('humanReason', () => {
  it('names a LinkedIn conflict ahead of the shared email that proposed the pair', () => {
    expect(
      humanReason(
        evidence(
          ['email', 'ada@example.com', 0.95],
          ['profile_url_conflict', 'linkedin.com/in/ada-one ≠ linkedin.com/in/ada-two', 0],
        ),
      ),
    ).toBe('Different LinkedIn profiles — likely two people');
  });

  it('explains a partial overlap', () => {
    expect(
      humanReason(
        evidence(
          ['profile_url', 'linkedin.com/in/ada-one', 0.8],
          [
            'profile_url_partial',
            'linkedin.com/in/ada-one ≠ linkedin.com/in/ada-one, linkedin.com/in/bo-two',
            0,
          ],
        ),
      ),
    ).toBe('One card lists two LinkedIn profiles');
  });

  it('explains a contested equal profile', () => {
    expect(
      humanReason(
        evidence(
          ['profile_url', 'linkedin.com/in/ada-one', 0.8],
          ['profile_url_check', 'family_name_conflict', 0],
          ['name_overlap', 'ada', 0.58],
        ),
      ),
    ).toBe('Same LinkedIn profile, but names or connection dates differ');
  });

  it('names the profile on an exact match', () => {
    expect(humanReason(evidence(['profile_url', 'linkedin.com/in/ada-one', 0.95]))).toBe(
      'Same LinkedIn profile: linkedin.com/in/ada-one',
    );
  });

  it('names a phone country conflict as two people', () => {
    expect(
      humanReason(
        evidence(['name_cluster', 'ada', 0.5], ['phone_country_conflict', '+442079460958 ≠ +12079460958', 0]),
      ),
    ).toBe('Same digits, different countries — likely two people');
  });

  it.each([
    ['given_name_conflict', 'Same phone number +1 (202) 555-0142, but names differ'],
    ['family_name_conflict', 'Same phone number +1 (202) 555-0142, but names differ'],
    ['shared_line', 'Same phone number +1 (202) 555-0142, but shared household line'],
    ['self_endpoint', 'Same phone number +1 (202) 555-0142, but one side is you'],
    ['suffix_conflict', 'Same phone number +1 (202) 555-0142, but names are a Jr/Sr pair'],
    ['self_endpoint, given_name_conflict', 'Same phone number +1 (202) 555-0142, but one side is you'],
  ])('names the number and says why a shared phone was held back (%s)', (reason, expected) => {
    expect(humanReason(evidence(['phone', '+12025550142', 0.85], ['phone_check', reason, 0]))).toBe(expected);
  });

  it('keeps "country not confirmed" for an unconfirmed phone with no check marker', () => {
    expect(humanReason(evidence(['phone', '2025550142', 0.75]))).toBe(
      'Same phone digits: 202-555-0142 — country not confirmed',
    );
    expect(humanReason(evidence(['phone', '+12025550142', 0.95]))).toBe('Same phone: +1 (202) 555-0142');
  });

  it('names every number an item carries', () => {
    expect(humanReason(evidence(['phone', '+12025550142, +442079460958', 0.95]))).toBe(
      'Same phone: +1 (202) 555-0142, +442079460958',
    );
  });

  it('says why a shared email with you was not merged automatically', () => {
    expect(
      humanReason(evidence(['email', 'ada@example.com', 0.85], ['email_check', 'self_endpoint', 0])),
    ).toBe('Same email ada@example.com, but one side is you and the names differ');
    // Held on a mailbox found outside the evidence items.
    expect(humanReason(evidence(['name_overlap', 'quill', 0.5], ['email_check', 'self_endpoint', 0]))).toBe(
      'Shares an email with you, but the names differ',
    );
  });

  it("says why two contacts' shared email was not merged automatically", () => {
    expect(
      humanReason(evidence(['email', 'ada@example.com', 0.85], ['email_check', 'name_conflict', 0])),
    ).toBe('Same email ada@example.com, but the names differ');
    expect(humanReason(evidence(['email_check', 'name_conflict', 0]))).toBe(
      'Same email, but the names differ',
    );
  });

  it('leaves the older reasons alone when there is no profile evidence', () => {
    expect(humanReason(evidence(['email', 'ada@example.com', 0.95]))).toBe('Same email: ada@example.com');
    expect(humanReason(evidence(['name_overlap', 'lovelace', 0.62]))).toBe('Names share “lovelace”');
  });
});

describe('the shared phone numbers a card shows', () => {
  it('formats North American numbers, groups bare digits without a country, and leaves the rest', () => {
    expect(formatPhoneNumber('+12125550118')).toBe('+1 (212) 555-0118');
    expect(formatPhoneNumber('2125550118')).toBe('212-555-0118');
    expect(formatPhoneNumber('+442079460958')).toBe('+442079460958');
    expect(formatPhoneNumber('5550142')).toBe('5550142');
  });

  it('reads the numbers from phone items only, once each, keyed on their last ten digits', () => {
    expect(
      sharedPhoneNumbers(
        evidence(
          ['phone', '+12125550118, 2125550118', 0.85],
          ['phone_check', 'given_name_conflict', 0],
          ['phone_country_conflict', '+442079460958 ≠ +12079460958', 0],
          ['email', 'ada@example.com', 0.95],
        ),
      ),
    ).toEqual([{ key: '2125550118', display: '+1 (212) 555-0118' }]);
  });
});

describe('groupMergeCandidates', () => {
  /** Only the fields grouping reads; every name is invented. */
  function candidate(id: string, people: Array<[id: string, name: string]>, items: Evidence): MergeCandidate {
    return {
      id,
      evidence: items,
      people: people.map(([personId, name]) => ({ id: personId, name, isSelf: false })),
    } as unknown as MergeCandidate;
  }

  const cluster = evidence(['name_cluster', 'ada', 0.62]);

  it('offers a bare given name against its fuller matches as one picker', () => {
    const groups = groupMergeCandidates([
      candidate(
        'c1',
        [
          ['p-ada', 'Ada'],
          ['p-one', 'Ada Quillfeather'],
        ],
        cluster,
      ),
      candidate(
        'c2',
        [
          ['p-ada', 'Ada'],
          ['p-two', 'Ada Brightwater'],
        ],
        cluster,
      ),
    ]);

    expect(groups.map((group) => group.type)).toEqual(['cluster']);
  });

  it('keeps a pair with different LinkedIn profiles out of the picker, so its warning shows', () => {
    const groups = groupMergeCandidates([
      candidate(
        'c1',
        [
          ['p-ada', 'Ada'],
          ['p-one', 'Ada Quillfeather'],
        ],
        cluster,
      ),
      candidate(
        'c2',
        [
          ['p-ada', 'Ada'],
          ['p-two', 'Ada Brightwater'],
        ],
        evidence(
          ['name_cluster', 'ada', 0.62],
          ['profile_url_conflict', 'linkedin.com/in/ada-one ≠ linkedin.com/in/ada-two', 0],
        ),
      ),
      candidate(
        'c3',
        [
          ['p-ada', 'Ada'],
          ['p-three', 'Ada Marsh'],
        ],
        cluster,
      ),
    ]);

    expect(groups.map((group) => group.type).sort()).toEqual(['cluster', 'pair']);
    const pair = groups.find((group) => group.type === 'pair');
    expect(pair?.type === 'pair' ? pair.candidate.id : null).toBe('c2');
  });

  it('keeps a pair whose phone digits are two countries out of the picker too', () => {
    const groups = groupMergeCandidates([
      candidate(
        'c1',
        [
          ['p-ada', 'Ada'],
          ['p-one', 'Ada Quillfeather'],
        ],
        cluster,
      ),
      candidate(
        'c2',
        [
          ['p-ada', 'Ada'],
          ['p-two', 'Ada Brightwater'],
        ],
        evidence(
          ['name_cluster', 'ada', 0.62],
          ['phone_country_conflict', '+442079460958 ≠ +12079460958', 0],
        ),
      ),
      candidate(
        'c3',
        [
          ['p-ada', 'Ada'],
          ['p-three', 'Ada Marsh'],
        ],
        cluster,
      ),
    ]);

    const pair = groups.find((group) => group.type === 'pair');
    expect(pair?.type === 'pair' ? pair.candidate.id : null).toBe('c2');
  });
});
