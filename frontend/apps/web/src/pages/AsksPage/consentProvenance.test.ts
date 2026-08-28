import { describe, expect, it } from 'vitest';

import {
  channelSentence,
  consentLockLabel,
  consentLockState,
  consentSentence,
  coveredComponentPurpose,
  COVERED_COMPONENT_PURPOSE,
  formatMoment,
  shortThumbprint,
  uncoveredComponents,
  type ChannelFacts,
  type ConsentLockState,
} from './consentProvenance';

const THUMB = 'a'.repeat(43);

const SIGNED: ChannelFacts = {
  keyThumbprint: THUMB,
  verifiedAt: '2026-08-26T12:00:00.000Z',
  covered: ['@method', '@target-uri', 'content-digest'],
};

const UNSIGNED: ChannelFacts = { keyThumbprint: null, verifiedAt: null, covered: [] };

describe('consentLockState', () => {
  it('is sealed only when consent AND a verified signature are both present', () => {
    expect(consentLockState({ consent: 'standing-grant', channel: SIGNED })).toBe('sealed');
    expect(consentLockState({ consent: 'owner-decision', channel: SIGNED })).toBe('sealed');
  });

  it('is consented when the channel was unsigned', () => {
    expect(consentLockState({ consent: 'standing-grant', channel: UNSIGNED })).toBe('consented');
    expect(consentLockState({ consent: 'owner-decision', channel: UNSIGNED })).toBe('consented');
  });

  /**
   * WEAKEST WINS. A signature proves who asked, not that they were allowed to,
   * so an undecided ask must not read as protected just because it arrived
   * signed.
   */
  it('reports pending for an undecided ask even when the signature verified', () => {
    expect(consentLockState({ consent: 'undecided', channel: SIGNED })).toBe('pending');
    expect(consentLockState({ consent: 'undecided', channel: UNSIGNED })).toBe('pending');
  });

  it('treats a half-populated channel as unsigned rather than as signed', () => {
    // The backend CHECK makes this unreachable, but a partially-populated
    // channel must never round UP to "signed" if one ever arrives.
    expect(
      consentLockState({
        consent: 'standing-grant',
        channel: { keyThumbprint: THUMB, verifiedAt: null, covered: [] },
      }),
    ).toBe('consented');
    expect(
      consentLockState({
        consent: 'standing-grant',
        channel: { keyThumbprint: null, verifiedAt: '2026-08-26T12:00:00.000Z', covered: [] },
      }),
    ).toBe('consented');
  });
});

describe('consentLockLabel', () => {
  it('carries the state in TEXT for every state, never colour alone', () => {
    const states: ConsentLockState[] = ['open', 'pending', 'consented', 'sealed'];

    for (const state of states) {
      const { label, meaning } = consentLockLabel(state);
      expect(label.length).toBeGreaterThan(0);
      expect(meaning.length).toBeGreaterThan(0);
    }
  });

  it('gives each state a distinct label', () => {
    const labels = (['open', 'pending', 'consented', 'sealed'] as ConsentLockState[]).map(
      (state) => consentLockLabel(state).label,
    );

    expect(new Set(labels).size).toBe(labels.length);
  });

  it('does not describe a pending ask as though something was shared', () => {
    expect(consentLockLabel('pending').meaning).toMatch(/Nothing has been shared/);
  });
});

describe('COVERED_COMPONENT_PURPOSE', () => {
  it('describes exactly the three components the profile accepts', () => {
    expect(Object.keys(COVERED_COMPONENT_PURPOSE).sort()).toEqual([
      '@method',
      '@target-uri',
      'content-digest',
    ]);
  });

  it('says what each one PROTECTS, not just what it is', () => {
    for (const entry of Object.values(COVERED_COMPONENT_PURPOSE)) {
      expect(entry.protects).toMatch(/Stops/);
    }
  });
});

describe('coveredComponentPurpose', () => {
  it('describes a known component', () => {
    expect(coveredComponentPurpose('content-digest').title).toBe('The question itself');
  });

  /**
   * Our parser accepts three components. Anything else means the profile
   * widened and this table did not — and silently dropping the row would show a
   * signature covering more than the modal admits.
   */
  it('reports an unknown component as unknown rather than hiding it', () => {
    const purpose = coveredComponentPurpose('@authority');

    expect(purpose.title).toBe('@authority');
    expect(purpose.protects).toMatch(/does not have a description/);
  });
});

describe('uncoveredComponents', () => {
  it('is empty for a complete body signature', () => {
    expect(uncoveredComponents(['@method', '@target-uri', 'content-digest'], true)).toEqual([]);
  });

  it('names what a short signature left out', () => {
    expect(uncoveredComponents(['@method'], true)).toEqual(['@target-uri', 'content-digest']);
  });

  it('does not report content-digest missing on a bodyless request', () => {
    // A collect request has no body, so requiring the digest there would be a
    // false negative on every poll.
    expect(uncoveredComponents(['@method', '@target-uri'], false)).toEqual([]);
    expect(uncoveredComponents(['@method', '@target-uri'], true)).toEqual(['content-digest']);
  });
});

describe('shortThumbprint', () => {
  it('abbreviates a real thumbprint', () => {
    expect(shortThumbprint(THUMB)).toBe('aaaaaa…aaaa');
  });

  it('leaves anything that is not thumbprint-shaped ALONE', () => {
    // Truncating a surprising value makes it harder to notice, not easier.
    expect(shortThumbprint('not-a-thumbprint')).toBe('not-a-thumbprint');
    expect(shortThumbprint('')).toBe('');
  });
});

describe('channelSentence', () => {
  it('names the key and says who checked it when signed', () => {
    const sentence = channelSentence(SIGNED, 'Dana');

    expect(sentence).toContain('Dana');
    expect(sentence).toContain(shortThumbprint(THUMB));
    expect(sentence).toContain('checked that signature');
  });

  it('states the unsigned case plainly, without alarm', () => {
    const sentence = channelSentence(UNSIGNED, 'Dana');

    expect(sentence).toContain('unsigned channel');
    // Unsigned is the common case today and is not a defect. A UI that painted
    // it as a warning would train people to ignore warnings.
    expect(sentence).not.toMatch(/warning|danger|insecure|unsafe/i);
  });
});

describe('consentSentence', () => {
  it('distinguishes a standing grant from a decision the owner made', () => {
    expect(consentSentence('standing-grant', 'Dana')).toMatch(/standing grant/);
    expect(consentSentence('standing-grant', 'Dana')).toMatch(/without asking you/);
    expect(consentSentence('owner-decision', 'Dana')).toMatch(/yourself/);
  });

  it('does not claim anything was shared for an undecided ask', () => {
    expect(consentSentence('undecided', 'Dana')).toMatch(/Nothing has been shared yet/);
  });
});

describe('formatMoment', () => {
  it('renders a real timestamp', () => {
    expect(formatMoment('2026-08-26T12:00:00.000Z')).not.toBe('2026-08-26T12:00:00.000Z');
  });

  it('falls back to the raw string rather than printing Invalid Date', () => {
    expect(formatMoment('not a date')).toBe('not a date');
  });
});
