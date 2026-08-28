import { describe, expect, it } from 'vitest';

import {
  actorIsDelegated,
  grantUsageLine,
  grantsLapsingWithin,
  lapseNudge,
  purposeAbsentNote,
  purposeLine,
  actorLine,
  answerFormLabel,
  askApproveLabel,
  askDecisionNote,
  askDecisionState,
  askStatusLabel,
  disclosureMagnitudeNote,
  grantModeBadge,
  grantModeLabel,
  needsOwnerReview,
  outcomeBadge,
  outcomeSentence,
  OWNER_ANSWER_FORMS,
  PEER_TRUST_TIERS,
  peerTrustCeilingNote,
  peerTrustLabel,
  provenanceLine,
  rungLabel,
  widensPeerTrust,
  withheldNote,
} from './askPresentation';

describe('grant mode presentation', () => {
  it('states the mode in words, never colour alone (WCAG 1.4.1)', () => {
    // Every badge carries a text label as well as a variant.
    for (const mode of ['auto', 'review', 'block'] as const) {
      const badge = grantModeBadge(mode);
      expect(badge.label.trim().length).toBeGreaterThan(0);
      expect(grantModeLabel(mode).trim().length).toBeGreaterThan(0);
    }
  });

  it('distinguishes blocked from ask-first in the label itself', () => {
    expect(grantModeBadge('block').label).not.toBe(grantModeBadge('review').label);
    expect(grantModeLabel('auto')).not.toBe(grantModeLabel('review'));
  });
});

describe('askStatusLabel', () => {
  it('names each lifecycle state in owner-facing words', () => {
    expect(askStatusLabel('under_review')).toMatch(/review/i);
    expect(askStatusLabel('declined')).toMatch(/declined/i);
    expect(askStatusLabel('answered')).toMatch(/answered/i);
  });

  it('flags only under_review as needing the owner', () => {
    expect(needsOwnerReview('under_review')).toBe(true);
    for (const status of ['sent', 'delivered', 'answered', 'declined', 'expired'] as const) {
      expect(needsOwnerReview(status)).toBe(false);
    }
  });
});

describe('provenanceLine', () => {
  it('says a human reviewed it only when one actually did', () => {
    const reviewed = provenanceLine({ responderName: 'Sam', review: 'reviewed' });
    expect(reviewed).toContain('reviewed by Sam');

    const auto = provenanceLine({ responderName: 'Sam', review: 'auto' });
    expect(auto).not.toContain('reviewed by Sam');
    expect(auto).toMatch(/automatically/i);
  });

  it('claims neither review nor automation when the wire did not say', () => {
    // The asker's projection of an answer has no auto/reviewed flag and a NULL
    // consent basis, on purpose. A card that filled the gap with either value
    // would put a provenance claim on screen that the server never made — the
    // one thing the provenance line exists to prevent.
    const unknown = provenanceLine({ responderName: 'Sam', review: 'undisclosed' });

    expect(unknown).not.toContain('reviewed by Sam');
    expect(unknown).not.toMatch(/automatically/i);
    expect(unknown).toMatch(/not disclosed to you/i);
  });

  it('always attributes the answer to the responder', () => {
    expect(provenanceLine({ responderName: 'Devon', review: 'auto' })).toContain("Devon's Companion");
    expect(provenanceLine({ responderName: 'Devon', review: 'undisclosed' })).toContain("Devon's Companion");
  });

  it('includes the consent basis when there is one', () => {
    expect(
      provenanceLine({ responderName: 'Sam', review: 'reviewed', consentBasis: 'family grant' }),
    ).toContain('family grant');
  });
});

describe('withheldNote', () => {
  it('stays quiet when nothing was withheld', () => {
    expect(withheldNote(0)).toBeNull();
    expect(withheldNote(-1)).toBeNull();
  });

  it('discloses the count but never which items', () => {
    expect(withheldNote(1)).toBe('1 item withheld');
    expect(withheldNote(4)).toBe('4 items withheld');
  });
});

describe('rungLabel', () => {
  it('describes every rung of the disclosure ladder distinctly', () => {
    const labels = (['none', 'boolean', 'count', 'summary', 'redacted', 'full'] as const).map(rungLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('askDecisionState', () => {
  it('separates an already-authorized ask from one still awaiting the owner', () => {
    // `AskService.submit` leaves an auto-authorized ask at `delivered` with a
    // consent basis stamped — exactly the second shape `isAnswerable` accepts.
    // Rendering that as a pending consent decision claims a gate that is open.
    expect(askDecisionState('delivered', 'grant-1')).toBe('pre-authorized');
    expect(askDecisionState('under_review', 'grant-1')).toBe('covered-review');
    expect(askDecisionState('under_review', null)).toBe('unreviewed');
    expect(askDecisionState('delivered', null)).toBe('unreviewed');
  });

  it('says the quarantine line ONLY for an ask no grant covers', () => {
    expect(askDecisionNote('unreviewed')).toMatch(/no standing grant/i);
    expect(askDecisionNote('pre-authorized')).not.toMatch(/no standing grant/i);
    expect(askDecisionNote('covered-review')).not.toMatch(/no standing grant/i);
  });

  it('does not ask for permission that was already given', () => {
    expect(askDecisionNote('pre-authorized')).toMatch(/not for your permission/i);
    expect(askApproveLabel('pre-authorized')).toBe('Answer now');
    expect(askApproveLabel('unreviewed')).toBe('Approve and answer');
  });
});

describe('owner answer-form ladder', () => {
  it('offers only forms that can cap an answer, never one that reshapes it', () => {
    // `identity` sits on the same rung as `boolean` but reads differently to the
    // asker, so it is a different answer rather than a smaller one.
    expect([...OWNER_ANSWER_FORMS]).toEqual(['boolean', 'existence', 'attribute']);
  });

  it('phrases every offer as a ceiling, because that is what the backend applies', () => {
    // `narrowerForm` keeps whichever of the owner's pick and the inferred form
    // discloses LESS, so "at most" is the only true reading of a pick.
    for (const form of OWNER_ANSWER_FORMS) {
      expect(answerFormLabel(form)).toMatch(/^At most /);
    }

    expect(new Set(OWNER_ANSWER_FORMS.map(answerFormLabel)).size).toBe(OWNER_ANSWER_FORMS.length);
  });
});

describe('disclosure-history presentation', () => {
  it('never collapses an auto-answer into a plain "answered"', () => {
    // These are the same event from the asker's side and completely different
    // events from the owner's: one is a decision they made, the other is a rule
    // they wrote once acting for them while they were not looking. Merging them
    // hides the only outcome an owner might want to go and stop.
    expect(outcomeBadge('auto_answered').label).not.toBe(outcomeBadge('answered').label);
    expect(outcomeSentence('auto_answered', 'Ada')).toMatch(/without asking you/i);
    expect(outcomeSentence('answered', 'Ada')).toMatch(/you reviewed/i);
  });

  it('states plainly that nothing crossed on a declined or expired row', () => {
    for (const outcome of ['declined', 'expired'] as const) {
      expect(outcomeSentence(outcome, 'Ada')).toMatch(/nothing was shared/i);
      expect(disclosureMagnitudeNote(outcome, 0)).toMatch(/nothing was shared/i);
    }
  });

  it('does not let a zero-item ANSWER read like a declined one', () => {
    // A yes/no discloses no item references and still told the asker something.
    // Printing "0 items shared" over both makes the owner's own receipt
    // understate what left the box.
    const answered = disclosureMagnitudeNote('answered', 0);

    expect(answered).toMatch(/still something shared/i);
    expect(answered).not.toBe(disclosureMagnitudeNote('declined', 0));
  });

  it('counts items when there were any', () => {
    expect(disclosureMagnitudeNote('answered', 1)).toBe('1 item shared');
    expect(disclosureMagnitudeNote('auto_answered', 4)).toBe('4 items shared');
  });
});

describe('peer trust ladder', () => {
  it('is ordered widest-first, which is what makes widening detectable', () => {
    expect([...PEER_TRUST_TIERS]).toEqual(['family', 'trusted', 'peer', 'stranger']);
  });

  it('calls a move up the ladder widening and a move down not', () => {
    // The asymmetry drives the confirmation: raising a tier retroactively
    // enlarges every future answer, including ones a grant already authorized.
    expect(widensPeerTrust('stranger', 'family')).toBe(true);
    expect(widensPeerTrust('peer', 'trusted')).toBe(true);
    expect(widensPeerTrust('family', 'stranger')).toBe(false);
    expect(widensPeerTrust('peer', 'peer')).toBe(false);
  });

  it('treats a tier it does not know as the widest, so any move toward it confirms', () => {
    // A value from a newer server must fail toward an unnecessary prompt, never
    // toward a silent escalation.
    expect(widensPeerTrust('stranger', 'household')).toBe(true);
    expect(widensPeerTrust('household', 'stranger')).toBe(false);
  });

  it('never maps an unknown tier onto a familiar word', () => {
    expect(peerTrustLabel('household')).toBe('household');
    expect(peerTrustCeilingNote('household')).toMatch(/unbounded until you check/i);
  });

  it('states what each known tier actually caps, matching TIER_CEILINGS', () => {
    // `stranger` is `{'*': 'boolean', location: 'none'}` in policy.ts, and this
    // sentence is the owner's only sight of that table.
    expect(peerTrustCeilingNote('stranger')).toMatch(/yes or no at most/i);
    expect(peerTrustCeilingNote('stranger')).toMatch(/never disclosed/i);
    expect(peerTrustCeilingNote('family')).toMatch(/location is redacted/i);

    // Every known tier says something different — a shared sentence would make
    // the dial look decorative.
    const notes = PEER_TRUST_TIERS.map(peerTrustCeilingNote);

    expect(new Set(notes).size).toBe(PEER_TRUST_TIERS.length);
  });

  it('states the EFFECTIVE ceiling, not the row in the table', () => {
    // Two rules in `disclosureCeiling` run after the `TIER_CEILINGS` lookup and
    // both tighten it, and reading the table alone got all three of these
    // sentences wrong once already:
    //
    //   1. the sensitive floor returns `none` for location/health/finance/
    //      secrets at every tier below `family`, so `trusted`'s
    //      `location: 'summary'` and `peer`'s `location: 'count'` rows are
    //      unreachable;
    //   2. a per-class entry may only tighten `'*'`, so `peer`'s
    //      `photos: 'redacted'` is clamped down to `summary`.
    //
    // Each assertion below fails if the copy drifts back to the table reading.
    for (const tier of ['trusted', 'peer'] as const) {
      const note = peerTrustCeilingNote(tier);

      expect(note).toMatch(/location, health, finances and secrets are never disclosed/i);
      expect(note).not.toMatch(/location is (summarised|only ever a count)/i);
    }

    // Naming a class must never buy MORE, and the peer note is where a reader
    // would otherwise conclude it does.
    expect(peerTrustCeilingNote('peer')).toMatch(/naming “photos” does not change that/i);
    expect(peerTrustCeilingNote('peer')).not.toMatch(/photos are redacted/i);

    // `family` is the one tier exempt from the sensitive floor — the fact that
    // actually separates it from `trusted`, and the one an owner promoting
    // somebody needs in front of them.
    expect(peerTrustCeilingNote('family')).toMatch(/only tier where health, finances and secrets/i);
    expect(peerTrustCeilingNote('trusted')).not.toMatch(/only tier/i);
  });
});

describe('actorLine — who, or what, is asking', () => {
  it('says nothing when the ask declares no actor', () => {
    // Inventing "a person, presumably" would be a claim about the one thing
    // the asker declined to commit to.
    expect(actorLine(null)).toBeNull();
    expect(actorLine(undefined)).toBeNull();
  });

  it('distinguishes a person from their Companion from delegated software', () => {
    expect(actorLine({ kind: 'person' })).toMatch(/a person is asking/);
    expect(actorLine({ kind: 'first-party-agent' })).toMatch(/own Companion/);
    expect(actorLine({ kind: 'third-party-agent' })).toMatch(/delegated to/);
  });

  /**
   * `label` is a string the ASKER writes and this box never verifies — the same
   * class of input as the prompt. So it is attributed, not asserted.
   */
  it('quotes the label rather than asserting it', () => {
    const line = actorLine({ kind: 'third-party-agent', label: 'Definitely Safe Assistant' }) ?? '';

    expect(line).toContain('calling itself');
    expect(line).toContain('Definitely Safe Assistant');
  });

  it('omits the quoting clause for a blank label', () => {
    expect(actorLine({ kind: 'first-party-agent', label: '  ' })).not.toContain('calling itself');
  });

  it('claims nothing it cannot support for an unrecognized kind', () => {
    const line = actorLine({ kind: 'quantum-butler' }) ?? '';

    expect(line).toMatch(/does not recognise/);
    expect(line).not.toContain('quantum-butler');
  });
});

describe('actorIsDelegated', () => {
  it('is true only for software acting on someone’s behalf', () => {
    expect(actorIsDelegated({ kind: 'first-party-agent' })).toBe(true);
    expect(actorIsDelegated({ kind: 'third-party-agent' })).toBe(true);
    expect(actorIsDelegated({ kind: 'person' })).toBe(false);
  });

  /**
   * An ask with no actor is the ordinary case today — nothing sends the field
   * yet. Marking every ask as noteworthy would make the mark worthless by the
   * time it means something.
   */
  it('is false for an undeclared actor, not true-by-default', () => {
    expect(actorIsDelegated(null)).toBe(false);
    expect(actorIsDelegated(undefined)).toBe(false);
  });
});

describe('purposeLine / purposeAbsentNote — why they say they want this', () => {
  it('attributes the purpose rather than asserting it', () => {
    // This box cannot verify why anyone wants anything. A line that read
    // "For: wedding invites" would assert something nobody checked.
    const line = purposeLine('wedding invites') ?? '';

    expect(line).toMatch(/They say/);
    expect(line).toContain('wedding invites');
  });

  it('trims, so padding does not become part of the quoted phrase', () => {
    expect(purposeLine('  lunch  ')).toContain('“lunch”');
  });

  it.each([[null], [undefined], [''], ['   '], [42], [{}]])('reports %p as no stated purpose', (value) => {
    expect(purposeLine(value)).toBeNull();
    expect(purposeAbsentNote(value)).toMatch(/did not say/);
  });

  /**
   * "They did not say why" is a real input to a consent decision. A card that
   * simply omitted the line would leave the owner unable to tell it from "the
   * app did not show me".
   */
  it('says nothing extra once a purpose IS stated', () => {
    expect(purposeAbsentNote('wedding invites')).toBeNull();
  });
});

describe('grantUsageLine — dormant vs busy', () => {
  const NOW = new Date('2026-08-26T12:00:00.000Z');
  const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

  it('states "Never used" plainly and without alarm', () => {
    // The ordinary state of a grant somebody wrote in advance — which is
    // exactly what standing consent is for.
    expect(grantUsageLine({ useCount: 0, lastUsedAt: null }, NOW)).toBe('Never used');
    expect(grantUsageLine({ useCount: 0 }, NOW)).toBe('Never used');
  });

  it('treats a count with no timestamp as never used, rather than half-reporting', () => {
    expect(grantUsageLine({ useCount: 5, lastUsedAt: null }, NOW)).toBe('Never used');
  });

  it('singularizes one use', () => {
    expect(grantUsageLine({ useCount: 1, lastUsedAt: at(3) }, NOW)).toBe('Used once · last 3 days ago');
  });

  it.each([
    [0, 'today'],
    [1, 'yesterday'],
    [9, '9 days ago'],
    [45, '1 month ago'],
    [90, '3 months ago'],
  ])('renders %s days since last use as "%s"', (days, expected) => {
    expect(grantUsageLine({ useCount: 4, lastUsedAt: at(days) }, NOW)).toBe(
      `Used 4 times · last ${expected}`,
    );
  });

  it('drops the "last" clause rather than printing a bad date', () => {
    expect(grantUsageLine({ useCount: 4, lastUsedAt: 'not a date' }, NOW)).toBe('Used 4 times');
  });
});

describe('grantsLapsingWithin / lapseNudge', () => {
  const NOW = new Date('2026-08-26T12:00:00.000Z');
  const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

  const grant = (over: Partial<{ active: boolean; expiresAt: string | null }> = {}) => ({
    active: true,
    expiresAt: inDays(10),
    ...over,
  });

  it('finds live grants expiring inside the horizon', () => {
    expect(grantsLapsingWithin([grant(), grant({ expiresAt: inDays(2) })], 30, NOW)).toHaveLength(2);
  });

  it('excludes grants expiring beyond it', () => {
    expect(grantsLapsingWithin([grant({ expiresAt: inDays(90) })], 30, NOW)).toEqual([]);
  });

  /**
   * A revoked grant cannot lapse, and one with no expiry never will. Counting
   * either inflates a nudge whose whole value is being rare enough to read.
   */
  it('excludes revoked grants and grants with no expiry', () => {
    expect(grantsLapsingWithin([grant({ active: false })], 30, NOW)).toEqual([]);
    expect(grantsLapsingWithin([grant({ expiresAt: null })], 30, NOW)).toEqual([]);
  });

  it('excludes an expiry already in the past — that lapsed, it is not about to', () => {
    expect(grantsLapsingWithin([grant({ expiresAt: inDays(-1) })], 30, NOW)).toEqual([]);
  });

  it('ignores an unparseable expiry rather than counting it', () => {
    expect(grantsLapsingWithin([grant({ expiresAt: 'soon' })], 30, NOW)).toEqual([]);
  });

  it('says nothing at all when nothing is lapsing', () => {
    // A banner that renders every time teaches people to look past the banner.
    expect(lapseNudge(0, 30)).toBeNull();
  });

  it('singularizes one grant and explains the consequence', () => {
    const nudge = lapseNudge(1, 30) ?? '';

    expect(nudge).toContain('1 grant');
    expect(nudge).toMatch(/stop answering/);
  });
});
