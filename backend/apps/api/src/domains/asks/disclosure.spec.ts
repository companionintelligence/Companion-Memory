import { ASK_ARCHETYPES, formForArchetype } from './askGrammar';
import { buildDisclosedAnswer, countFreeSummary, formDisclosesItems, inferAnswerForm } from './disclosure';
import type { AskQuery, DisclosedItem } from './types';

function query(overrides: Partial<AskQuery> = {}): AskQuery {
  return { queryType: 'photos', prompt: 'do you have photos of us?', ...overrides };
}

const MATCHES: DisclosedItem[] = [
  { id: 'a', type: 'file' },
  { id: 'b', type: 'file' },
  { id: 'c', type: 'event' },
];

describe('inferAnswerForm', () => {
  it('maps known query types to forms and defaults to retrieval', () => {
    expect(inferAnswerForm(query({ queryType: 'photos' }))).toBe('retrieval');
    expect(inferAnswerForm(query({ queryType: 'identity' }))).toBe('identity');
    expect(inferAnswerForm(query({ queryType: 'relationship' }))).toBe('boolean');
    expect(inferAnswerForm(query({ queryType: 'where' }))).toBe('attribute');
    expect(inferAnswerForm(query({ queryType: 'existence' }))).toBe('existence');
  });

  it('detects a "do you know" prompt as boolean', () => {
    expect(inferAnswerForm(query({ queryType: 'misc', prompt: 'Do you know Carol?' }))).toBe('boolean');
  });

  // Every archetype `parseAskQueryType` accepts must resolve to the form
  // `formForArchetype` declares for it. `content` and `availability` are the
  // two that used to match no branch and fall through to `retrieval` — the
  // widest form — so an ask the grammar caps at a count was disclosing item
  // references instead.
  it.each(ASK_ARCHETYPES)('caps the %s archetype at its declared form', (archetype) => {
    expect(inferAnswerForm(query({ queryType: archetype }))).toBe(formForArchetype(archetype));
  });

  it('never widens an archetype to retrieval', () => {
    const widened = ASK_ARCHETYPES.filter(
      (archetype) => inferAnswerForm(query({ queryType: archetype })) === 'retrieval',
    );

    expect(widened).toEqual([]);
  });

  // The archetype wins over the prompt heuristic. A `content` ask whose prompt
  // happens to open with "do you know" is still a content ask, and reading the
  // ASKER's prose to pick a form is how the form becomes their choice.
  it('prefers the archetype over the prompt heuristic', () => {
    expect(inferAnswerForm(query({ queryType: 'content', prompt: 'Do you know Carol?' }))).toBe(
      'existence',
    );
  });
});

describe('formDisclosesItems', () => {
  it('only the retrieval form returns item references', () => {
    expect(formDisclosesItems('retrieval')).toBe(true);
    for (const form of ['boolean', 'existence', 'attribute', 'identity'] as const) {
      expect(formDisclosesItems(form)).toBe(false);
    }
  });
});

describe('buildDisclosedAnswer', () => {
  it('retrieval form returns item references (id+type only, no raw content)', () => {
    const answer = buildDisclosedAnswer({ form: 'retrieval', matches: MATCHES, consentBasis: null });

    expect(answer.disclosedCount).toBe(3);
    expect(answer.withheldCount).toBe(0);
    expect(answer.items).toEqual([
      { id: 'a', type: 'file' },
      { id: 'b', type: 'file' },
      { id: 'c', type: 'event' },
    ]);
    // references only — the item objects carry no content/url keys
    expect(Object.keys(answer.items[0]).sort()).toEqual(['id', 'type']);
  });

  it('applies owner redaction: withheld items are counted but never itemized', () => {
    const answer = buildDisclosedAnswer({
      form: 'retrieval',
      matches: MATCHES,
      redactedIds: ['b', 'c'],
      consentBasis: 'grant-1',
    });

    expect(answer.disclosedCount).toBe(1);
    expect(answer.withheldCount).toBe(2);
    expect(answer.items).toEqual([{ id: 'a', type: 'file' }]);
    expect(answer.consentBasis).toBe('grant-1');
  });

  it('non-retrieval forms disclose counts/summary only — never item references', () => {
    const boolean = buildDisclosedAnswer({ form: 'boolean', matches: MATCHES, consentBasis: null });
    expect(boolean.items).toEqual([]);
    expect(boolean.disclosedCount).toBe(3); // still counted for the summary
    expect(boolean.summary).toMatch(/confirmed/i);

    const existenceNone = buildDisclosedAnswer({ form: 'existence', matches: [], consentBasis: null });
    expect(existenceNone.items).toEqual([]);
    expect(existenceNone.summary).toMatch(/none/i);
  });
});

/**
 * The summary the ASKER is allowed to read. `buildSummary` and the ceiling's
 * `countOnlySummary` both put the match count into prose, so gating only the
 * numeric field moved the oracle rather than closing it.
 */
describe('countFreeSummary', () => {
  it('never contains a digit, for any form', () => {
    const forms = ['boolean', 'existence', 'attribute', 'identity', 'retrieval'] as const;
    for (const form of forms) {
      expect(countFreeSummary(form, true)).not.toMatch(/\d/);
      expect(countFreeSummary(form, false)).not.toMatch(/\d/);
    }
  });

  it('still distinguishes "something" from "nothing" — the boolean floor the rung allows', () => {
    expect(countFreeSummary('boolean', true)).toBe('Yes.');
    expect(countFreeSummary('boolean', false)).toBe('No.');
    expect(countFreeSummary('existence', true)).toBe('They have at least one matching item.');
    expect(countFreeSummary('existence', false)).toBe('They have none.');
    expect(countFreeSummary('identity', true)).toBe('Confirmed.');
  });
});
