import { describe, expect, it } from 'vitest';

import {
  citationTypeLabel,
  evidenceScopeSentence,
  formatCitationDate,
  hasEvidenceRecord,
  readAnswerCitations,
  readUncitedRecords,
  unaccountedEvidenceCount,
} from './answerEvidence';

describe('readAnswerCitations — absence', () => {
  // The whole point of the defensive read: the backend field names are being
  // settled in parallel, and older answers genuinely have no evidence at all.
  // Every one of these has to be an empty list, never a throw.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'nope'],
    ['a number', 7],
    ['an array', [{ text: 'x' }]],
    ['an answer with no citation field', { id: 'a1', text: 'Tea.', source: 'inferred' }],
    ['an explicitly empty list', { id: 'a1', citations: [] }],
    ['a citation field that is not a list', { id: 'a1', citations: 'three messages' }],
    ['citations made of junk', { citations: [null, 3, [], '', '   ', {}] }],
  ])('reads %s as no evidence', (_label, record) => {
    expect(readAnswerCitations(record)).toEqual([]);
  });
});

describe('readAnswerCitations — presence', () => {
  it('reads the shape the drawer needs off a fully-populated citation', () => {
    const [citation] = readAnswerCitations({
      citations: [
        {
          type: 'communication',
          id: 'c-1',
          title: 'Text with Dana',
          snippet: 'Booking the 7am flight so I can be back for dinner.',
          date: '2026-03-04T09:12:00.000Z',
          voice: 'own',
        },
      ],
    });

    expect(citation).toMatchObject({
      type: 'communication',
      id: 'c-1',
      label: 'Text with Dana',
      snippet: 'Booking the 7am flight so I can be back for dinner.',
      date: '2026-03-04T09:12:00.000Z',
      voice: 'own',
    });
  });

  it('finds the list under any of the plausible field names, and one level down', () => {
    const shapes = [
      { citations: [{ text: 'a' }] },
      { evidence: [{ text: 'a' }] },
      { answerCitations: [{ text: 'a' }] },
      { sources: [{ text: 'a' }] },
      { groundedIn: [{ text: 'a' }] },
      { provenance: { citations: [{ text: 'a' }] } },
      { answerProvenance: { evidence: [{ text: 'a' }] } },
    ];

    for (const shape of shapes) {
      expect(readAnswerCitations(shape)).toHaveLength(1);
    }
  });

  it('reads a RecallLine verbatim — that is the shape the recall engine already emits', () => {
    // RecallResult.lines is { text, voice }; if the backend forwards those
    // straight through, they must land without a translation layer.
    const citations = readAnswerCitations({
      lines: [
        { text: 'Left the house at 6.', voice: 'own' },
        { text: 'are you up yet?', voice: 'other' },
      ],
    });

    expect(citations.map((citation) => [citation.snippet, citation.voice])).toEqual([
      ['Left the house at 6.', 'own'],
      ['are you up yet?', 'other'],
    ]);
  });

  it('derives voice from message direction, because that is where own/other comes from', () => {
    const citations = readAnswerCitations({
      citations: [
        { text: 'sent', direction: 'outbound' },
        { text: 'received', direction: 'inbound' },
        { text: 'flagged', isOwn: true },
        { text: 'unknowable' },
      ],
    });

    expect(citations.map((citation) => citation.voice)).toEqual(['own', 'other', 'own', null]);
  });

  it('leaves voice null rather than guessing, so the drawer can say it was not recorded', () => {
    const [citation] = readAnswerCitations({ citations: [{ text: 'x', direction: 'sideways' }] });

    expect(citation?.voice).toBeNull();
  });

  it('does not repeat the snippet as its own heading', () => {
    const [citation] = readAnswerCitations({ citations: [{ title: 'Same', text: 'Same' }] });

    expect(citation?.label).toBeNull();
    expect(citation?.snippet).toBe('Same');
  });

  it('accepts a bare string as a snippet-only citation', () => {
    expect(readAnswerCitations({ citations: ['You said so on the 4th.'] })).toEqual([
      {
        key: '0:text',
        type: null,
        id: null,
        label: null,
        snippet: 'You said so on the 4th.',
        date: null,
        voice: null,
      },
    ]);
  });

  it('gives every citation a distinct key even when the objects are identical', () => {
    const citations = readAnswerCitations({
      citations: [
        { type: 'event', id: 'e1', text: 'Dinner' },
        { type: 'event', id: 'e1', text: 'Dinner' },
      ],
    });

    expect(new Set(citations.map((citation) => citation.key)).size).toBe(2);
  });
});

describe('citationTypeLabel', () => {
  it('names the appliance’s own object types in a reader’s words', () => {
    expect(citationTypeLabel('communication')).toBe('Message');
    expect(citationTypeLabel('event')).toBe('Event');
    expect(citationTypeLabel('content')).toBe('Note');
  });

  it('falls back to a de-snaked version of whatever the backend sends', () => {
    expect(citationTypeLabel('object_observation')).toBe('Object observation');
    expect(citationTypeLabel(null)).toBe('Record');
  });
});

describe('formatCitationDate', () => {
  it('formats a real date and passes an unparseable one through unchanged', () => {
    expect(formatCitationDate('2026-03-04T09:12:00.000Z')).toMatch(/2026/);
    expect(formatCitationDate('sometime last spring')).toBe('sometime last spring');
    expect(formatCitationDate(null)).toBeNull();
  });
});

describe('readAnswerCitations — the shapes the API actually sends', () => {
  /** `AnswerEvidenceCitation` verbatim: { line, type, id, at, voice, snippet }. */
  const CITATION = {
    line: 3,
    type: 'communication',
    id: '0198f0aa-1111-7000-8000-000000000001',
    at: '2026-02-02T05:41:00.000Z',
    voice: 'own' as const,
    snippet: 'up at 5:40 again, going for a run',
  };

  const WRAPPER = { citations: [CITATION], linesShown: 12, linesOwn: 4, model: 'qwen3:8b' };

  it('reads the catalogue shape — the answer carries `evidence`', () => {
    // GET /api/questions/catalogue → QuestionCatalogueAnswer.evidence.
    // This is the Self page and the Reflections catalogue.
    const [citation] = readAnswerCitations({
      id: 'a1',
      text: 'Morning person.',
      source: 'inferred',
      confidence: 0.82,
      rationale: 'You are up before 7 most weekdays.',
      evidence: WRAPPER,
      answeredAt: '2026-03-04T09:12:00.000Z',
    });

    expect(citation).toMatchObject({
      type: 'communication',
      id: '0198f0aa-1111-7000-8000-000000000001',
      snippet: 'up at 5:40 again, going for a run',
      date: '2026-02-02T05:41:00.000Z',
      voice: 'own',
    });
    // `line` is an ordinal, not prose — it must never be mistaken for a snippet.
    expect(citation?.label).toBeNull();
  });

  it('reads the entity shape — the answer carries `answerEvidence`', () => {
    // GET /api/answers → AnswerEntity.toEgressType, which uses the column name.
    // Same wrapper, different key: the Reflections "Your answers" tab would
    // silently show an empty evidence list if this one were missed.
    const [citation] = readAnswerCitations({
      id: 'a1',
      answer: 'Morning person.',
      answerSource: 'inferred',
      answerConfidence: 0.82,
      answerRationale: 'You are up before 7 most weekdays.',
      answerEvidence: WRAPPER,
    });

    expect(citation?.snippet).toBe('up at 5:40 again, going for a run');
    expect(citation?.voice).toBe('own');
  });

  it('reads the wrapper as empty when the column was never written', () => {
    // NULL on ci.answers.answer_evidence: a typed answer, an import, or an
    // inferred row from before the column existed.
    expect(readAnswerCitations({ id: 'a1', evidence: null })).toEqual([]);
    expect(readAnswerCitations({ id: 'a1', answerEvidence: null })).toEqual([]);
  });

  it('names the resolution types the backend can emit', () => {
    const types = [
      'communication',
      'event',
      'content',
      'item',
      'person',
      'place',
      'concept',
      'note',
      'browser-activity',
      'file',
      'thread',
      'receipt',
      'graph-node',
      'agent-memory',
    ];

    for (const type of types) {
      const label = citationTypeLabel(type);
      expect(label).not.toBe('Record');
      expect(label[0]).toBe(label[0]!.toUpperCase());
      expect(label).not.toContain('-');
    }
  });
});

describe('hasEvidenceRecord', () => {
  // A NULL column and a wrapper that cited nothing are different facts, and the
  // drawer says different things about them. `readAnswerCitations` returns []
  // for both, so this is the only thing that can tell them apart.
  it.each([
    ['no record at all', { id: 'a1' }, false],
    ['an explicitly null column', { id: 'a1', answerEvidence: null }, false],
    ['a catalogue wrapper that cited nothing', { evidence: { citations: [], linesShown: 21 } }, true],
    ['an entity wrapper that cited nothing', { answerEvidence: { citations: [], linesShown: 21 } }, true],
    ['a wrapper with citations', { evidence: { citations: [{ snippet: 'x' }] } }, true],
    ['a non-object', 'nope', false],
  ])('reads %s as %s', (_label, record, expected) => {
    expect(hasEvidenceRecord(record)).toBe(expected);
  });
});

describe('readUncitedRecords', () => {
  // The distinction the drawer's honesty rests on. `null` means the row never
  // kept its unused lines, so the panel must not offer an empty "also searched"
  // group beside a count of twenty; `[]` means the model named everything it
  // was shown, which is a real answer.
  it.each([
    ['no record at all', { id: 'a1' }, null],
    ['an explicitly null column', { id: 'a1', answerEvidence: null }, null],
    [
      'a wrapper written before unused lines were kept',
      { evidence: { citations: [], linesShown: 21 } },
      null,
    ],
    ['a wrapper whose uncited list is not a list', { evidence: { uncited: 'eighteen' } }, null],
    ['a non-object', 'nope', null],
    ['a wrapper that named everything it read', { evidence: { citations: [], uncited: [] } }, []],
  ])('reads %s as %s', (_label, record, expected) => {
    expect(readUncitedRecords(record)).toEqual(expected);
  });

  it('reads unused lines through the same shape as cited ones', () => {
    // One reader, one component: the ONLY thing separating a used record from
    // an unused one is which array it arrived in.
    const [cited] = readAnswerCitations({
      evidence: {
        citations: [
          {
            line: 1,
            type: 'communication',
            id: 'c-1',
            at: '2026-02-02T05:41:00.000Z',
            voice: 'own',
            snippet: 'up at 5:40',
          },
        ],
      },
    });
    const [unused] = readUncitedRecords({
      evidence: {
        uncited: [
          {
            line: 4,
            type: 'communication',
            id: 'c-4',
            at: '2026-02-03T22:10:00.000Z',
            voice: 'other',
            snippet: 'you are always up before me',
          },
        ],
      },
    })!;

    expect(Object.keys(unused!).sort()).toEqual(Object.keys(cited!).sort());
    // The voice an unused line carries is the most informative field in the
    // group: an inbound line retrieved and correctly left alone is the speaker
    // gate visibly working.
    expect(unused).toMatchObject({ type: 'communication', id: 'c-4', voice: 'other' });
  });

  it('never reads the citation list as the unused one', () => {
    // The two key lists are disjoint on purpose. If `citations` could satisfy
    // an uncited alias, the drawer would show the same rows as supporting the
    // answer AND as passed over.
    expect(readUncitedRecords({ evidence: { citations: [{ snippet: 'up at 5:40' }] } })).toBeNull();
  });
});

describe('evidenceScopeSentence', () => {
  it('leads with the count of the list, not the count of the retrieval', () => {
    // The bug: "20 records were put in front of the model, 14 of them your own"
    // printed above a list of two reads as eighteen records being hidden.
    expect(evidenceScopeSentence(2, { linesShown: 20, linesOwn: 14 })).toBe(
      '2 records support this answer. 20 were searched, 14 of them your own.',
    );
  });

  it.each([
    [
      1,
      { linesShown: 12, linesOwn: 4 },
      '1 record supports this answer. 12 were searched, 4 of them your own.',
    ],
    [
      0,
      { linesShown: 21, linesOwn: 15 },
      'No record was named as supporting this answer. 21 were searched, 15 of them your own.',
    ],
    // No wider set to explain: a second clause here invites the reader to hunt
    // for a distinction that is not there.
    [2, { linesShown: 2, linesOwn: 2 }, '2 records support this answer.'],
    [2, { linesShown: 1, linesOwn: 1 }, '2 records support this answer.'],
    // An older row that recorded citations and nothing else.
    [3, { linesShown: null, linesOwn: null }, '3 records support this answer.'],
    [1, { linesShown: 4, linesOwn: null }, '1 record supports this answer. 4 were searched.'],
    // "4 of them your own" out of 4 is technically true and reads as a subset.
    [
      1,
      { linesShown: 4, linesOwn: 4 },
      '1 record supports this answer. 4 were searched, all of them your own.',
    ],
  ])('phrases %s cited against %o', (cited, summary, expected) => {
    expect(evidenceScopeSentence(cited, summary)).toBe(expected);
  });
});

describe('unaccountedEvidenceCount', () => {
  // Both stored arrays are capped and older rows kept no unused lines at all,
  // so the reader can always subtract. Stating the shortfall is the difference
  // between a panel that is incomplete and one that is misleading.
  it.each([
    ['a row with no unused lines kept', 1, 0, { linesShown: 12 }, 11],
    ['a row where both lists reconcile', 2, 18, { linesShown: 20 }, 0],
    ['a capped uncited list', 2, 24, { linesShown: 30 }, 4],
    ['a row that never recorded a total', 2, 3, { linesShown: null }, 0],
    // Never negative: a jsonb row from another build can carry more rows than
    // it claims to have read, and "-3 more records" is worse than silence.
    ['more rows than the total claims', 4, 9, { linesShown: 5 }, 0],
  ])('reads %s as %i unaccounted', (_label, cited, uncited, summary, expected) => {
    expect(unaccountedEvidenceCount(cited, uncited, summary)).toBe(expected);
  });
});
