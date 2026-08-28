import type { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import type { RecallService } from '@ci/domains/agent';
import type { EventPayloads, Events } from '@ci/domains/events';
import type { Answer, AnswerService, QuestionService } from '@ci/domains/intelligence';
import { CONFIDENCE_IMPLIED_CEILING, type OllamaService, PROMPT_MODEL } from '@ci/domains/llm';
import type { PersonalizationService } from '@ci/domains/personalization';
import type { SearchService } from '@ci/domains/search-next';

import { AnswerInferenceListener } from '../AnswerInferenceListener';

type Payload = EventPayloads[Events.INFER_QUESTION_ANSWER];

/**
 * What the model is contracted to return: answer + confidence + rationale, as
 * strict JSON. The default is deliberately well above the floor and above the
 * evidence ceiling for a bare prompt, so the confidence a test asserts on is the
 * calibrated one rather than whatever the model claimed.
 */
function structuredResponse(
  overrides: {
    answer?: string;
    confidence?: number;
    rationale?: string;
    asked_for?: string;
    support?: string;
    first_person_evidence?: unknown;
  } = {},
): string {
  return JSON.stringify({
    answer: 'Blue, definitely blue.',
    confidence: 0.9,
    rationale: 'You named blue in two prior answers.',
    // Line 1 of the default recall result below, which is one of the user's OWN
    // records. Every write in this file goes through the speaker gate, so the
    // default has to cite something that clears it.
    first_person_evidence: [1],
    ...overrides,
  });
}

type Voice = 'own' | 'other';

/**
 * A recall result shaped like the real one: the block, plus the per-line speaker
 * tag RecallService now attaches after entity resolution.
 */
function recallResult(texts: string[], voice: Voice = 'own') {
  return mixedRecallResult(voice === 'own' ? texts : [], voice === 'own' ? [] : texts);
}

/**
 * The database row a fake recall line stands for.
 *
 * Every real recall line now carries one, and it is what the listener records as
 * the answer's evidence — so a helper that omitted it would let the citation lane
 * be tested against a shape production never produces. `own-2` is the second own
 * line, `other-1` the first inbound one, so an assertion can name the row it
 * expects to see cited without counting through the block.
 */
function refFor(text: string, voice: Voice, index: number) {
  return {
    type: 'communication',
    id: `${voice}-${index + 1}`,
    at: `2024-03-0${Math.min(index + 1, 9)}T00:00:00.000Z`,
  };
}

/** Own lines first, then other people's — the order the prompt numbers them in. */
function mixedRecallResult(own: string[], other: string[]) {
  const lines = [
    ...own.map((text, index) => ({ text, voice: 'own' as Voice, ref: refFor(text, 'own', index) })),
    ...other.map((text, index) => ({
      text,
      voice: 'other' as Voice,
      ref: refFor(text, 'other', index),
    })),
  ];

  return {
    block: `## Relevant context\n${lines.map((line) => line.text).join('\n')}`,
    resultCount: lines.length,
    lines,
  };
}

/** The one own-record line every default build is grounded in. */
const DEFAULT_EVIDENCE_LINE = '[I wrote, Mar 3, 2024] "repainted the study a deep blue"';

/**
 * What a default build stores as the answer's provenance: the single own-record
 * line the default `first_person_evidence: [1]` cites, named by the row it came
 * out of rather than only by its text.
 */
const DEFAULT_STORED_EVIDENCE = {
  citations: [
    {
      line: 1,
      type: 'communication',
      id: 'own-1',
      at: '2024-03-01T00:00:00.000Z',
      voice: 'own',
      snippet: DEFAULT_EVIDENCE_LINE,
    },
  ],
  // The default build retrieves exactly one line and cites it, so there is
  // nothing left over. Empty rather than absent, and that is the point: it says
  // the model named everything it was shown, where an absent key would say the
  // unused lines were never kept at all.
  uncited: [],
  linesShown: 1,
  linesOwn: 1,
  model: PROMPT_MODEL,
};

/**
 * The evidence ceiling for a default build: no related answers, no dossier (the
 * listener no longer sends one) and the single retrieved own-record line above —
 * {@link estimateInferredAnswerConfidence}(0, false, 1) === 0.45 + 0.05.
 * Every default build in this file hits it, so it is the confidence the writes
 * carry.
 */
const DEFAULT_EVIDENCE_CONFIDENCE = 0.5;

function makeQuestion(id: string, text: string, questionType?: string) {
  return { id, text, questionType } as Awaited<ReturnType<QuestionService['findById']>>;
}

function makeAnswer(
  overrides: {
    id?: string;
    answer?: string;
    answeredAt?: Date;
    question?: { id: string };
    answerSource?: string;
  } = {},
): Answer {
  return {
    id: 'ans-existing',
    answer: 'previous answer',
    answeredAt: new Date('2026-01-01T00:00:00Z'),
    question: { id: 'other-question' },
    // Defaults to an answer the USER typed, since most callers just need "some
    // existing answer" for unrelated assertions — and the related-answers block
    // now carries only the user's own answers, machine-inferred rows being the
    // measured source of cross-question bleed. Tests of the overwrite gate and
    // of the inferred-row filter override this explicitly.
    answerSource: 'user_input',
    ...overrides,
  } as unknown as Answer;
}

function buildListener(overrides: {
  answerService?: Partial<AnswerService>;
  questionService?: Partial<QuestionService>;
  searchService?: Partial<SearchService>;
  recallService?: Partial<RecallService>;
  personalizationService?: Partial<PersonalizationService>;
  ollamaService?: Partial<OllamaService>;
}) {
  const answerService = {
    findByQuestionId: jest.fn().mockResolvedValue(null),
    findByIds: jest.fn().mockResolvedValue([]),
    findAll: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue(makeAnswer()),
    update: jest.fn().mockResolvedValue(makeAnswer()),
    ...overrides.answerService,
  } as unknown as AnswerService;

  const questionService = {
    findById: jest.fn().mockResolvedValue(makeQuestion('q-1', 'What is your favorite color?')),
    ...overrides.questionService,
  } as unknown as QuestionService;

  const searchService = {
    search: jest.fn().mockResolvedValue([]),
    ...overrides.searchService,
  } as unknown as SearchService;

  // Defaults to one line of the user's OWN record. It used to default to "the
  // corpus had nothing", but an empty block now means there is no first-person
  // line for `first_person_evidence` to cite and every answer is discarded — so
  // the bare default would have asserted the speaker gate over and over instead
  // of whatever each test is actually about.
  const recallService = {
    recall: jest.fn().mockResolvedValue(recallResult([DEFAULT_EVIDENCE_LINE])),
    ...overrides.recallService,
  } as unknown as RecallService;

  const personalizationService = {
    decideAction: jest.fn().mockResolvedValue('auto'),
    ...overrides.personalizationService,
  } as unknown as PersonalizationService;

  const ollamaService = {
    chat: jest.fn().mockResolvedValue({ message: { content: structuredResponse() } }),
    ...overrides.ollamaService,
  } as unknown as OllamaService;

  const logger = { setContext() {}, log() {}, warn() {}, error() {} } as unknown as LoggerService;

  const listener = new AnswerInferenceListener(
    answerService,
    questionService,
    searchService,
    recallService,
    personalizationService,
    ollamaService,
    logger,
  );

  return {
    listener,
    answerService,
    questionService,
    searchService,
    recallService,
    personalizationService,
    ollamaService,
  };
}

describe('AnswerInferenceListener.inferQuestionAnswer — early exits', () => {
  it('skips (no LLM call) when the payload has no owner', async () => {
    const { listener, questionService, ollamaService } = buildListener({});

    await listener.inferQuestionAnswer({ ownerId: null, questionId: 'q-1' } as Payload);

    expect(questionService.findById).not.toHaveBeenCalled();
    expect(ollamaService.chat).not.toHaveBeenCalled();
  });

  it('skips when the question no longer exists', async () => {
    const { listener, ollamaService, questionService } = buildListener({
      questionService: { findById: jest.fn().mockResolvedValue(null) },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(questionService.findById).toHaveBeenCalled();
    expect(ollamaService.chat).not.toHaveBeenCalled();
  });

  it('does not write an answer when the LLM returns empty/whitespace-only content', async () => {
    const { listener, answerService } = buildListener({
      ollamaService: { chat: jest.fn().mockResolvedValue({ message: { content: '   ' } }) },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('never puts the user dossier in the prompt — nothing in it is citable evidence', async () => {
    // The measured fabrication: "Which hobby have you kept the longest, and for
    // how many years?" answered "Woodworking — about fifteen years now." at
    // 0.90, rationale "The User Context section explicitly states …". The
    // dossier has no line numbers, no dates and no speaker, so it can never
    // satisfy `first_person_evidence` — and on the reference appliance the self
    // entity resolves to an imported vCard contact, so it describes a stranger.
    const { listener, ollamaService } = buildListener({});

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    expect(ragThread[0].content).not.toContain('User Context');
    expect(ragThread[0].content).not.toContain('User dossier');
  });
});

describe('AnswerInferenceListener.inferQuestionAnswer — confidence floor', () => {
  it('writes NOTHING when the model reports a confidence below the floor', async () => {
    // The whole point of the feature: a question the appliance cannot answer
    // well is left unanswered rather than filled with a fabrication that will
    // sit in the user's memory looking exactly like something they said.
    const { listener, answerService, personalizationService } = buildListener({
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: structuredResponse({ confidence: 0.2, rationale: 'Nothing to go on.' }) },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
    // Refused before the trust gate — a low-confidence answer is not something
    // to queue for review either, it is something not to have written.
    expect(personalizationService.decideAction).not.toHaveBeenCalled();
  });

  it('writes an answer whose confidence sits exactly on the floor', async () => {
    const { listener, answerService } = buildListener({
      ollamaService: {
        chat: jest.fn().mockResolvedValue({ message: { content: structuredResponse({ confidence: 0.4 }) } }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ answerConfidence: 0.4 }),
    );
  });

  it('persists the model score capped by the evidence actually in the prompt', async () => {
    // A model handed a dossier and six prior answers may legitimately be sure;
    // one handed nothing may not, however sure it sounds. Both defaults here are
    // the bare case, so the confident 0.9 is capped to the bare-context ceiling.
    const { listener, answerService } = buildListener({
      ollamaService: {
        chat: jest.fn().mockResolvedValue({ message: { content: structuredResponse({ confidence: 0.95 }) } }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ answerConfidence: DEFAULT_EVIDENCE_CONFIDENCE }),
    );
  });

  it('writes nothing when the model answers in prose instead of the schema', async () => {
    // No score means no way to hold the floor against it, and a substituted
    // default would be a number no model ever produced.
    const { listener, answerService } = buildListener({
      ollamaService: {
        chat: jest.fn().mockResolvedValue({ message: { content: 'Blue, I reckon. Pretty sure.' } }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('asks the model for the structured shape rather than prose', async () => {
    const { listener, ollamaService } = buildListener({});

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const [, , options] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      unknown,
      { format?: Record<string, unknown> },
    ];
    expect(options.format).toMatchObject({
      required: ['asked_for', 'support', 'first_person_evidence', 'answer', 'confidence', 'rationale'],
    });
  });

  it('states the confidence scale to the model in the system prompt', async () => {
    const { listener, ollamaService } = buildListener({});

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    expect(ragThread[0].content).toContain('confidence');
    expect(ragThread[0].content).toContain('rationale');
  });
});

describe('AnswerInferenceListener.inferQuestionAnswer — refusals are never written', () => {
  it('writes nothing when the model refuses, however confident it says it is', async () => {
    // The measured failure, end to end: three restaurant visits retrieved, the
    // model answers "I do not have this information recorded." and scores that
    // refusal 0.7 — above the 0.4 floor meant to filter it out. Persisted, it
    // would sit in ci.answers looking exactly like something the user typed.
    const { listener, answerService, personalizationService } = buildListener({
      recallService: {
        recall: jest
          .fn()
          .mockResolvedValue(
            recallResult(['[Browser] Directions to Choya Japanese Cuisine, Dana Point, CA']),
          ),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              answer: 'I do not have this information recorded.',
              confidence: 0.7,
              rationale: 'No line states a favorite cuisine.',
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
    // Dropped outright, not queued for a human to look at — there is nothing
    // here for a reviewer to approve.
    expect(personalizationService.decideAction).not.toHaveBeenCalled();
  });

  it.each([
    "I don't know.",
    'Unknown',
    'No information available.',
    'The evidence does not mention any cuisine.',
  ])('writes nothing for the refusal %p', async (answer) => {
    const { listener, answerService } = buildListener({
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: structuredResponse({ answer, confidence: 0.95 }) },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('still refuses a refusal when the owner has lowered the confidence floor beneath the clamp', async () => {
    // Isolates the listener's own gate from the parser's clamp. The clamp puts a
    // refusal at CONFIDENCE_NON_ANSWER (0.1), which the default 0.4 floor throws
    // out — but `reflection.minAnswerConfidence` is owner-configurable, and an
    // owner who set it to 0 would otherwise get "I don't know." written into
    // ci.answers as though they had said it.
    const reflection = config.reflection as { minAnswerConfidence: number };
    const originalFloor = reflection.minAnswerConfidence;
    reflection.minAnswerConfidence = 0;

    try {
      const { listener, answerService } = buildListener({
        ollamaService: {
          chat: jest.fn().mockResolvedValue({
            message: {
              content: structuredResponse({
                answer: 'I do not have this information recorded.',
                confidence: 0.7,
              }),
            },
          }),
        },
      });

      await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

      expect(answerService.create).not.toHaveBeenCalled();
      expect(answerService.update).not.toHaveBeenCalled();
    } finally {
      reflection.minAnswerConfidence = originalFloor;
    }
  });

  it('DOES write the synthesized answer the same evidence should have produced', async () => {
    // The other half of the fix, and the half a refusal-blocker alone would not
    // give you: naming what three restaurant visits actually show is a real
    // answer and must survive every gate.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest
          .fn()
          .mockResolvedValue(
            recallResult([
              '[Browser] Directions to Choya Japanese Cuisine, Dana Point, CA',
              '[Browser] Directions to El Patroncito Mexican Cuisine, Los Angeles, CA',
              '[Browser] Directions to Pailin Thai Cuisine, Hollywood Blvd, Los Angeles',
            ]),
          ),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              answer: 'Japanese, Mexican and Thai — I eat across all three.',
              confidence: 0.55,
              first_person_evidence: [1, 2, 3],
              rationale: 'Three restaurants looked up in browser history.',
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        text: 'Japanese, Mexican and Thai — I eat across all three.',
        answerConfidence: 0.55,
      }),
    );
  });
});

describe('AnswerInferenceListener.inferQuestionAnswer — the answer is written in the user’s voice', () => {
  it('writes the fact without the narrator framing wrapped around it', async () => {
    // Measured live: "My record shows I have maintained a strong, ongoing
    // general interest in hobbies…" was written to the owner's profile, where it
    // reads as them describing their own database. The fact is worth keeping;
    // the narration is stripped on the way in.
    const { listener, answerService } = buildListener({
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              answer: 'My record shows I have kept up with woodworking for fifteen years.',
              confidence: 0.8,
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        text: 'I have kept up with woodworking for fifteen years.',
        answerConfidence: DEFAULT_EVIDENCE_CONFIDENCE,
      }),
    );
  });

  it.each([
    // Narration that cannot be unpicked from the claim. Written to ci.answers it
    // would sit on the profile beside sentences the user typed themselves.
    'The user prefers mornings, based on the data.',
    'This person tends to message their sister most.',
    // The live pronouns row: a report on the record's silence, which no "I don't
    // know" pattern matched and which was therefore persisted at 0.1.
    'I have not explicitly stated my pronouns in this record.',
  ])('writes nothing for the narrated answer %p', async (answer) => {
    const { listener, answerService } = buildListener({
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: structuredResponse({ answer, confidence: 0.95 }) },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('drops the narrated answer even with the confidence floor set to zero', async () => {
    // This appliance ships with CI_REFLECTION_MIN_ANSWER_CONFIDENCE=0, so the
    // floor catches nothing and this gate is the only thing standing between the
    // model's narration and the user's profile.
    const reflection = config.reflection as { minAnswerConfidence: number };
    const originalFloor = reflection.minAnswerConfidence;
    reflection.minAnswerConfidence = 0;

    try {
      const { listener, answerService } = buildListener({
        ollamaService: {
          chat: jest.fn().mockResolvedValue({
            message: {
              content: structuredResponse({
                answer: 'I have not explicitly stated my pronouns in this record.',
                confidence: 0.1,
              }),
            },
          }),
        },
      });

      await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

      expect(answerService.create).not.toHaveBeenCalled();
      expect(answerService.update).not.toHaveBeenCalled();
    } finally {
      reflection.minAnswerConfidence = originalFloor;
    }
  });
});

describe('AnswerInferenceListener.inferQuestionAnswer — personalization decision gate', () => {
  it('writes nothing when the decision is "review" (left for the context prompt instead)', async () => {
    const { listener, answerService } = buildListener({
      personalizationService: { decideAction: jest.fn().mockResolvedValue('review') },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('writes nothing when the decision is "skip"', async () => {
    const { listener, answerService } = buildListener({
      personalizationService: { decideAction: jest.fn().mockResolvedValue('skip') },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });
});

describe('AnswerInferenceListener.inferQuestionAnswer — update vs create', () => {
  it('creates a new inferred answer when the user has not answered the question yet', async () => {
    const { listener, answerService } = buildListener({
      answerService: { findByQuestionId: jest.fn().mockResolvedValue(null) },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      {
        text: 'Blue, definitely blue.',
        question: { id: 'q-1' },
        answerMethod: 'inferred',
        answerSource: 'inferred',
        answerConfidence: DEFAULT_EVIDENCE_CONFIDENCE,
        answerRationale: 'You named blue in two prior answers.',
        answerEvidence: DEFAULT_STORED_EVIDENCE,
      },
    );
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('updates the EXISTING answer in place instead of creating a duplicate when one already exists', async () => {
    // A row this same path wrote before (answerSource: 'inferred') is fair game
    // to refresh — that is the intended re-inference path, not the overwrite bug.
    const existing = makeAnswer({ id: 'ans-42', answerSource: 'inferred' });
    const { listener, answerService } = buildListener({
      answerService: { findByQuestionId: jest.fn().mockResolvedValue(existing) },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.update).toHaveBeenCalledWith({ userId: 'user-1' }, 'ans-42', {
      text: 'Blue, definitely blue.',
      answerMethod: 'inferred',
      answerSource: 'inferred',
      answerConfidence: DEFAULT_EVIDENCE_CONFIDENCE,
      answerRationale: 'You named blue in two prior answers.',
      answerEvidence: DEFAULT_STORED_EVIDENCE,
    });
    expect(answerService.create).not.toHaveBeenCalled();
  });

  it('does NOT overwrite a real user-authored answer — the worst-case failure mode', async () => {
    // The scenario the audit flagged: a pre-existing, user-typed answer must
    // never be silently replaced just because an answer already exists for the
    // question. The gate is answerSource, not "does a row exist" — see
    // AnswerProvenance on the frontend, which keys the same "Inferred" vs
    // "Manual" distinction off this exact field.
    const userWritten = makeAnswer({
      id: 'ans-user',
      answer: 'I picked green myself.',
      answerSource: 'user_input',
    });
    const { listener, answerService } = buildListener({
      answerService: { findByQuestionId: jest.fn().mockResolvedValue(userWritten) },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.update).not.toHaveBeenCalled();
    expect(answerService.create).not.toHaveBeenCalled();
  });
});

describe('AnswerInferenceListener.findRelatedAnswers (via inferQuestionAnswer)', () => {
  it('resolves semantic search hits into related answers, passed to the LLM prompt', async () => {
    const hit1 = makeAnswer({ id: 'hit-1', answer: 'Loves hiking', question: { id: 'q-other-1' } });
    const { listener, searchService, answerService, ollamaService } = buildListener({
      searchService: { search: jest.fn().mockResolvedValue([{ id: 'hit-1' }]) },
      answerService: {
        findByQuestionId: jest.fn().mockResolvedValue(null),
        findByIds: jest.fn().mockResolvedValue([hit1]),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(searchService.search).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ mode: 'boosted', includeTypes: ['answer'] }),
    );
    expect(answerService.findByIds).toHaveBeenCalledWith({ userId: 'user-1' }, ['hit-1']);

    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    expect(ragThread[0].content).toContain('Loves hiking');
  });

  it('excludes the question being answered from its own related-answers context', async () => {
    const selfAnswer = makeAnswer({ id: 'self', answer: 'excluded-self-text', question: { id: 'q-1' } });
    const other = makeAnswer({ id: 'other', answer: 'included-other-text', question: { id: 'q-2' } });
    const { listener, ollamaService } = buildListener({
      searchService: { search: jest.fn().mockResolvedValue([{ id: 'self' }, { id: 'other' }]) },
      answerService: {
        findByQuestionId: jest.fn().mockResolvedValue(null),
        findByIds: jest.fn().mockResolvedValue([selfAnswer, other]),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    expect(ragThread[0].content).not.toContain('excluded-self-text');
    expect(ragThread[0].content).toContain('included-other-text');
  });

  it('falls back to recent answers when semantic search throws', async () => {
    const recent = makeAnswer({ id: 'recent-1', answer: 'fallback answer', question: { id: 'q-9' } });
    const { listener, answerService, ollamaService } = buildListener({
      searchService: { search: jest.fn().mockRejectedValue(new Error('search index down')) },
      answerService: {
        findByQuestionId: jest.fn().mockResolvedValue(null),
        findAll: jest.fn().mockResolvedValue([recent]),
      },
    });

    await expect(
      listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload),
    ).resolves.not.toThrow();

    expect(answerService.findAll).toHaveBeenCalled();
    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    expect(ragThread[0].content).toContain('fallback answer');
  });

  it('supplements thin semantic results (< 3 hits) with recent answers, newest first', async () => {
    const semanticHit = makeAnswer({ id: 'semantic-1', answer: 'from search', question: { id: 'q-a' } });
    const older = makeAnswer({
      id: 'recent-old',
      answer: 'older recent',
      question: { id: 'q-b' },
      answeredAt: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = makeAnswer({
      id: 'recent-new',
      answer: 'newer recent',
      question: { id: 'q-c' },
      answeredAt: new Date('2026-06-01T00:00:00Z'),
    });

    const { listener, ollamaService } = buildListener({
      searchService: { search: jest.fn().mockResolvedValue([{ id: 'semantic-1' }]) },
      answerService: {
        findByQuestionId: jest.fn().mockResolvedValue(null),
        findByIds: jest.fn().mockResolvedValue([semanticHit]),
        findAll: jest.fn().mockResolvedValue([older, newer]),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    const content = ragThread[0].content;
    expect(content).toContain('from search');
    expect(content).toContain('newer recent');
    expect(content).toContain('older recent');
    // Newest-first ordering among the recent-answers fallback.
    expect(content.indexOf('newer recent')).toBeLessThan(content.indexOf('older recent'));
  });

  it('does not fall back to recent answers when semantic search already returned >= 3 hits', async () => {
    const hits = ['h1', 'h2', 'h3'].map((id) => makeAnswer({ id, answer: id, question: { id: `q-${id}` } }));
    const { listener, answerService } = buildListener({
      searchService: { search: jest.fn().mockResolvedValue(hits.map((h) => ({ id: h.id }))) },
      answerService: {
        findByQuestionId: jest.fn().mockResolvedValue(null),
        findByIds: jest.fn().mockResolvedValue(hits),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.findAll).not.toHaveBeenCalled();
  });
});

describe('AnswerInferenceListener — grounding in the user’s own memory', () => {
  /** A recall block shaped like the real one: labelled, dated, one line each. */
  const recallBlock = recallResult;

  it('retrieves against the whole indexed corpus, not just prior answers', async () => {
    // The bug this feature exists to fix: the only retrieval the listener did
    // was scoped `includeTypes: ['answer']`, i.e. a few dozen rows out of the
    // ~900k the user has indexed. The corpus leg must be its own call.
    const { listener, recallService } = buildListener({});

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(recallService.recall).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ query: 'What is your favorite color?' }),
      expect.anything(),
    );
  });

  it('retrieves with the precision-first strategy, not the agent-lookup default', async () => {
    // The default strategy seeds with an OR-joined keyword search, which on a
    // question answers "What city do you live in?" with song titles carrying the
    // word City. Evidence for an inferred answer has to clear a higher bar than
    // an agent looking something up, so this call site asks for 'grounded'.
    const { listener, recallService } = buildListener({});

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(recallService.recall).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ strategy: 'grounded' }),
    );
  });

  it('keeps ci.answers out of the evidence, so its own past output is not evidence', async () => {
    // Every row in ci.answers was written by THIS listener. Retrieving them as
    // "evidence from the user's own imported memory" feeds the model its own
    // prior output — and most of those rows say "I do not have this information
    // recorded", which is the refusal this path exists to avoid re-learning.
    const { listener, recallService } = buildListener({});

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const options = (recallService.recall as jest.Mock).mock.calls[0][2];

    expect(options.excludeTypes).toContain('answer');
  });

  it('injects the retrieved lines into the system prompt as labelled EVIDENCE', async () => {
    const { listener, ollamaService } = buildListener({
      recallService: {
        recall: jest
          .fn()
          .mockResolvedValue(
            recallBlock(['[I wrote, Mar 3, 2024] "repainted the study a deep blue"', 'Blue paint order']),
          ),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    const systemPrompt = ragThread[0].content;
    expect(systemPrompt).toContain('EVIDENCE');
    // Provenance survives into the prompt, so the model can name it in the
    // rationale rather than gesturing at "your history".
    expect(systemPrompt).toContain('[I wrote, Mar 3, 2024] "repainted the study a deep blue"');
    // Numbered, so `first_person_evidence` has something to point at.
    expect(systemPrompt).toContain('1. [I wrote, Mar 3, 2024] "repainted the study a deep blue"');
  });

  it('raises the evidence ceiling, so a grounded answer is not capped like an ungrounded one', async () => {
    // Without this, widening retrieval changes nothing that reaches the
    // database: every answer, grounded or not, would still be pinned to the
    // bare-context ceiling and land one notch above the discard floor.
    const lines = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'];
    const { listener, answerService } = buildListener({
      recallService: { recall: jest.fn().mockResolvedValue(recallBlock(lines)) },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({ message: { content: structuredResponse({ confidence: 0.9 }) } }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    // estimateInferredAnswerConfidence(0, false, 6) === 0.45 + 6 * 0.05.
    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ answerConfidence: 0.75 }),
    );
  });

  it('tells the model when the corpus returned nothing, instead of staying silent about it', async () => {
    const { listener, ollamaService } = buildListener({
      recallService: { recall: jest.fn().mockResolvedValue({ block: '', resultCount: 0, lines: [] }) },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    expect(ragThread[0].content).toContain('No memory evidence was retrieved');
  });

  it('frames the evidence as a record of what the user DID, to be inferred from', async () => {
    // The measured failure was not retrieval: the corpus returned three
    // restaurant visits across three cuisines and the model still answered "I do
    // not have this information recorded." The prompt has to say that no line
    // will state the answer outright and that reading the pattern is the job.
    const { listener, ollamaService } = buildListener({
      recallService: {
        recall: jest
          .fn()
          .mockResolvedValue(recallBlock(['[Browser] Directions to Choya Japanese Cuisine, Dana Point, CA'])),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    const systemPrompt = ragThread[0].content;
    expect(systemPrompt).toContain('SYNTHESIS, NOT LOOKUP');
    expect(systemPrompt).toContain('do not require one of them to state it');
    expect(systemPrompt).toMatch(/indirect evidence is still evidence/i);
  });

  it('writes NOTHING when recall throws — an answer with no evidence is invented', async () => {
    // This used to write at the bare ceiling (0.45), one notch above the 0.4
    // floor: a first-person claim about the user with not one line of their
    // record behind it. With no evidence there is no own-record line to cite, so
    // the speaker gate discards it. Failing soft still means not throwing — the
    // question simply comes back unanswered.
    const { listener, answerService, ollamaService } = buildListener({
      recallService: { recall: jest.fn().mockRejectedValue(new Error('search index down')) },
    });

    await expect(
      listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload),
    ).resolves.not.toThrow();

    expect(ollamaService.chat).toHaveBeenCalled();
    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });
});

describe('AnswerInferenceListener — the related-answers block', () => {
  /** Both search paths into ci.answers return the same rows. */
  function withRelatedAnswers(answers: Answer[]) {
    return buildListener({
      searchService: {
        search: jest.fn().mockResolvedValue(answers.map((answer) => ({ type: 'answer', id: answer.id }))),
      },
      answerService: {
        findByIds: jest.fn().mockResolvedValue(answers),
        findAll: jest.fn().mockResolvedValue(answers),
        findByQuestionId: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(makeAnswer()),
        update: jest.fn().mockResolvedValue(makeAnswer()),
      },
    });
  }

  /**
   * Just the related-answers section. The prompt RULES quote refusal wording as
   * the thing to score low, so a whole-prompt substring check cannot tell "the
   * block leaked a refusal" from "the rules named one".
   */
  function relatedSectionOf(ollamaService: OllamaService) {
    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    const system = ragThread[0].content;
    const start = system.indexOf('Answers this person gave to OTHER questions');

    return start === -1
      ? system.slice(system.indexOf('No related prior answers were found'))
      : system.slice(start);
  }

  it('drops this listener’s own refusals, which are the absence of an answer', async () => {
    // 20 of the 23 rows in ci.answers on the reference corpus say exactly this,
    // and every one of them was written by this listener. Presented to the model
    // as "questions the user already answered", they read as evidence that
    // refusing is what this user does — the loop this filter breaks.
    const { listener, ollamaService } = withRelatedAnswers([
      makeAnswer({ id: 'a-1', answer: 'I do not have this information recorded.' }),
      makeAnswer({ id: 'a-2', answer: 'Toki Pona' }),
    ]);

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const related = relatedSectionOf(ollamaService);

    expect(related).toContain('Toki Pona');
    expect(related).not.toContain('I do not have this information recorded.');
  });

  it('says no related answers were found when refusals were all there was', async () => {
    // The refusals must not merely be hidden from the block — with nothing real
    // left, the prompt has to say so, or the model is told a section exists and
    // then handed an empty one.
    const { listener, ollamaService } = withRelatedAnswers([
      makeAnswer({ id: 'a-1', answer: 'I do not have this information recorded.' }),
      makeAnswer({ id: 'a-2', answer: "I don't have that information recorded." }),
    ]);

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(relatedSectionOf(ollamaService)).toContain('No related prior answers were found');
  });
});

describe('AnswerInferenceListener — the off-question gate', () => {
  /**
   * The measured live failure, reduced: "Which health conditions run in your
   * immediate family?" retrieved eighteen lines that matched on "family" and
   * "immediate", one of which was "doctors in my family." The model answered
   * that line rather than the question and scored it 0.90 — well-supported on
   * the topic, and about something else entirely.
   */
  const healthQuestion = {
    questionService: {
      findById: jest
        .fn()
        .mockResolvedValue(makeQuestion('q-1', 'Which health conditions run in your immediate family?')),
    },
  };

  it('writes NOTHING when the model reports the evidence is only topical', async () => {
    const { listener, answerService } = buildListener({
      ...healthQuestion,
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              asked_for: 'named medical conditions occurring in my blood relatives',
              support: 'topical',
              answer: 'There are doctors in my family.',
              confidence: 0.9,
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('writes NOTHING when the evidence does not touch the question at all', async () => {
    const { listener, answerService } = buildListener({
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: structuredResponse({ support: 'none', confidence: 0.95 }) },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('refuses a near miss even with the confidence floor set to zero', async () => {
    // The gate has to be the load-bearing part, not the score: this appliance
    // ships with CI_REFLECTION_MIN_ANSWER_CONFIDENCE=0 on at least one real box,
    // so nothing downstream of the clamp stops an off-question answer.
    const reflection = config.reflection as { minAnswerConfidence: number };
    const originalFloor = reflection.minAnswerConfidence;
    reflection.minAnswerConfidence = 0;

    try {
      const { listener, answerService } = buildListener({
        ...healthQuestion,
        ollamaService: {
          chat: jest.fn().mockResolvedValue({
            message: {
              content: structuredResponse({
                support: 'topical',
                answer: 'There are doctors in my family.',
                confidence: 0.9,
              }),
            },
          }),
        },
      });

      await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

      expect(answerService.create).not.toHaveBeenCalled();
      expect(answerService.update).not.toHaveBeenCalled();
    } finally {
      reflection.minAnswerConfidence = originalFloor;
    }
  });

  it('still writes when the evidence genuinely answers the question', async () => {
    // The gate must cost nothing on the questions the corpus does answer — the
    // four that work today all come back `stated`.
    const { listener, answerService } = buildListener({
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({ support: 'stated', answer: 'Night owl.', confidence: 0.9 }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ text: 'Night owl.' }),
    );
  });

  it('writes an inference the evidence only implies, capped below the stated band', async () => {
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest
          .fn()
          .mockResolvedValue(recallResult(['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'])),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              support: 'implied',
              answer: 'Japanese, Mexican and Thai.',
              confidence: 0.95,
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        text: 'Japanese, Mexican and Thai.',
        answerConfidence: CONFIDENCE_IMPLIED_CEILING,
      }),
    );
  });

  it('leaves a model that gave no judgement exactly where it was', async () => {
    // Every pre-existing test in this file builds a response with no `support`
    // field. The gate is a constraint on a new judgement, never a new way to
    // lose an answer that predates it.
    const { listener, answerService } = buildListener({});

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalled();
  });
});

describe('AnswerInferenceListener — cross-question bleed', () => {
  /**
   * Measured: asked "What languages do you speak?", the model returned its own
   * earlier answer to "Which languages are you learning, if any?" verbatim and
   * scored it 0.9, with the rationale "The answer is explicitly provided in the
   * 'Related questions the user already answered' section". Every one of the 21
   * rows in ci.answers on the reference corpus was written by this listener, so
   * that block was this path reading back its own guesses as though the person
   * had said them.
   */
  function relatedBlockOf(ollamaService: OllamaService) {
    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    const system = ragThread[0].content;
    const start = system.indexOf('Answers this person gave to OTHER questions');

    // Section only. The prompt RULES quote the languages bleed as the worked
    // example of what NOT to do, so a whole-prompt substring check cannot tell
    // "the block leaked a prior inference" from "the rules named one".
    return start === -1
      ? system.slice(system.indexOf('No related prior answers were found'))
      : system.slice(start);
  }

  it('keeps this listener’s own prior inferences out of the prompt', async () => {
    const own = makeAnswer({
      id: 'a-inferred',
      answer: "I've been studying English, Sign Language, and German.",
      question: { id: 'q-learning' },
      answerSource: 'inferred',
    });
    const typed = makeAnswer({
      id: 'a-typed',
      answer: 'I picked green myself.',
      question: { id: 'q-colour' },
      answerSource: 'user_input',
    });

    const { listener, ollamaService } = buildListener({
      searchService: { search: jest.fn().mockResolvedValue([{ id: 'a-inferred' }, { id: 'a-typed' }]) },
      answerService: {
        findByQuestionId: jest.fn().mockResolvedValue(null),
        findByIds: jest.fn().mockResolvedValue([own, typed]),
        findAll: jest.fn().mockResolvedValue([own, typed]),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const prompt = relatedBlockOf(ollamaService);

    expect(prompt).not.toContain('Sign Language');
    expect(prompt).toContain('I picked green myself.');
  });

  it('tells the model a prior answer is background, never this question’s answer', async () => {
    const typed = makeAnswer({ id: 'a-typed', answer: 'Toki Pona', answerSource: 'user_input' });

    const { listener, ollamaService } = buildListener({
      searchService: { search: jest.fn().mockResolvedValue([{ id: 'a-typed' }]) },
      answerService: {
        findByQuestionId: jest.fn().mockResolvedValue(null),
        findByIds: jest.fn().mockResolvedValue([typed]),
        findAll: jest.fn().mockResolvedValue([typed]),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const prompt = relatedBlockOf(ollamaService);

    expect(prompt).toContain('Answers this person gave to OTHER questions');
    expect(prompt).toContain("never this question's answer");
  });
});

describe('AnswerInferenceListener — the speaker gate', () => {
  /**
   * The measured corpus shape: 168,385 inbound rows against 156,768 outbound, so
   * just over half of every retrieval is somebody else talking. Eight of the
   * thirteen answers stored before this gate rested on inbound citations.
   */
  function withInboundOnly() {
    return buildListener({
      recallService: {
        recall: jest
          .fn()
          .mockResolvedValue(
            mixedRecallResult(
              [],
              [
                '[someone else wrote to me, Feb 2, 2015] "I do have cats and definitely a cat person. :)"',
                '[someone else wrote to me, Apr 8, 2015] "I do have a cat."',
                '[someone else wrote to me, Feb 26, 2017] "And I have a cat"',
              ],
            ),
          ),
      },
    });
  }

  it('writes NOTHING when every retrieved line is somebody else talking', async () => {
    // "Are you more of a cat person or a dog person?" → "I am definitely a cat
    // person, and I have cats." at 0.95, off three other people's messages about
    // THEIR cats. The owner's only outbound pet line is
    // "My dog needs to be put down today :(".
    const { listener, answerService } = withInboundOnly();

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('writes nothing even when the model calls inbound-only evidence "stated" at 0.99', async () => {
    // The gate is deterministic on this side, so the model's own judgement
    // cannot buy its way past it — which is the whole difference between this
    // and a prompt rule.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest
          .fn()
          .mockResolvedValue(
            mixedRecallResult(
              [],
              ['[someone else wrote to me, Aug 11, 2014] "I always wanted a tree house"'],
            ),
          ),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              support: 'stated',
              confidence: 0.99,
              answer: 'I always wanted a tree house.',
              first_person_evidence: [1],
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
  });

  it('writes nothing when the model cites an inbound line number from a mixed block', async () => {
    // Own line is 1, the inbound lines are 2 and 3. Citing 3 is citing nothing.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest
          .fn()
          .mockResolvedValue(
            mixedRecallResult(
              ['[I wrote, Jun 28, 2010] "My dog needs to be put down today :("'],
              [
                '[someone else wrote to me, Feb 2, 2015] "definitely a cat person"',
                '[someone else wrote to me, Apr 8, 2015] "I do have a cat."',
              ],
            ),
          ),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              support: 'stated',
              answer: 'I am definitely a cat person.',
              first_person_evidence: [3],
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
  });

  it('still writes when the claim rests on the owner’s OWN line in the same mixed block', async () => {
    // Inbound context is kept, not filtered — an incoming "happy birthday!" is
    // real evidence about a birthday. The gate is about what CARRIES the claim.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest
          .fn()
          .mockResolvedValue(
            mixedRecallResult(
              ['[I wrote, Jun 25, 2010] "Really. I am a night owl."'],
              ['[someone else wrote to me, May 3, 2016] "I\'m a night owl..."'],
            ),
          ),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              support: 'stated',
              answer: 'Night owl.',
              confidence: 0.9,
              first_person_evidence: [1],
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ text: 'Night owl.' }),
    );
  });

  it('files the evidence under two headings so the model can tell the voices apart', async () => {
    const { listener, ollamaService } = withInboundOnly();

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    const prompt = ragThread[0].content;

    expect(prompt).toContain('WHAT OTHER PEOPLE SAID TO ME');
    expect(prompt).toContain('nothing this person wrote or did came back for this question');
    // Numbered across both sections, so a citation names exactly one line.
    expect(prompt).toContain('1. [someone else wrote to me, Feb 2, 2015]');
  });

  it('caps how much of the block other people are allowed to fill', async () => {
    // 52% of the corpus is inbound; uncapped, it crowds out the handful of lines
    // that can actually carry the answer.
    const { listener, ollamaService } = buildListener({
      recallService: {
        recall: jest.fn().mockResolvedValue(
          mixedRecallResult(
            ['mine'],
            Array.from({ length: 20 }, (_unused, index) => `theirs-${index}`),
          ),
        ),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const [, ragThread] = (ollamaService.chat as jest.Mock).mock.calls[0] as [
      unknown,
      Array<{ content: string }>,
    ];
    const prompt = ragThread[0].content;

    expect(prompt).toContain('theirs-5');
    expect(prompt).not.toContain('theirs-6');
  });

  it('ceilings the confidence on the FIRST-PERSON line count, not the total', async () => {
    // Ten lines of other people talking are worth the same ceiling as none:
    // estimateInferredAnswerConfidence(0, false, 1) === 0.5.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest.fn().mockResolvedValue(
          mixedRecallResult(
            ['mine'],
            Array.from({ length: 6 }, (_unused, index) => `theirs-${index}`),
          ),
        ),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({ message: { content: structuredResponse({ confidence: 0.95 }) } }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ answerConfidence: DEFAULT_EVIDENCE_CONFIDENCE }),
    );
  });
});

describe('AnswerInferenceListener — the citations written onto the answer', () => {
  /**
   * The point of this whole lane: `answer_rationale` is the model's SENTENCE
   * about its evidence, and until now that sentence was the only provenance the
   * owner got. A sentence naming records is unfalsifiable — the measured failure
   * this codebase already carries is a rationale citing a "User Context section"
   * that "explicitly states" a fact appearing nowhere in the corpus. Storing the
   * rows makes the claim checkable.
   */
  it('records the ROW behind each cited line, not just its text', async () => {
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest.fn().mockResolvedValue(mixedRecallResult(['I wrote this', 'and this too'], [])),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: structuredResponse({ first_person_evidence: [2] }) },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const written = (answerService.create as jest.Mock).mock.calls[0][1];

    // Line 2, not line 1: the citation has to follow the number the model gave,
    // or the drawer shows the owner a record the answer does not rest on.
    expect(written.answerEvidence.citations).toEqual([
      {
        line: 2,
        type: 'communication',
        id: 'own-2',
        at: '2024-03-02T00:00:00.000Z',
        voice: 'own',
        snippet: 'and this too',
      },
    ]);
  });

  it('cites in the model’s own order, not in retrieval order', async () => {
    // The first number the model named is the line it leant on hardest. Sorting
    // them back into block order would throw that away for nothing.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest.fn().mockResolvedValue(mixedRecallResult(['first', 'second', 'third'], [])),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: structuredResponse({ first_person_evidence: [3, 1] }) },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const written = (answerService.create as jest.Mock).mock.calls[0][1];

    expect(written.answerEvidence.citations.map((citation: { id: string }) => citation.id)).toEqual([
      'own-3',
      'own-1',
    ]);
  });

  it('stores only what the SPEAKER GATE let through — an inbound citation is not provenance', async () => {
    // The gate already refuses to let an inbound line carry the claim. The
    // citation lane must not quietly re-admit it as "evidence" in the drawer:
    // a line saying "I have a cat" under WHAT OTHER PEOPLE SAID TO ME means
    // SOMEONE ELSE has a cat, and showing it as the answer's grounding would
    // undo the gate in the one surface the owner actually reads.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest.fn().mockResolvedValue(mixedRecallResult(['my own line'], ['their line'])),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: structuredResponse({ first_person_evidence: [1, 2] }) },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const written = (answerService.create as jest.Mock).mock.calls[0][1];

    expect(written.answerEvidence.citations).toHaveLength(1);
    expect(written.answerEvidence.citations[0]).toMatchObject({ id: 'own-1', voice: 'own' });
  });

  it('reports how much was read, not only what was cited', async () => {
    // "Cited 1 of 9 lines read, 3 of them mine" is a different and more honest
    // statement than "cited 1 line", and the counts are only knowable here.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest
          .fn()
          .mockResolvedValue(mixedRecallResult(['a', 'b', 'c'], ['x', 'y', 'z', 'w', 'v', 'u'])),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const written = (answerService.create as jest.Mock).mock.calls[0][1];

    expect(written.answerEvidence).toMatchObject({ linesShown: 9, linesOwn: 3, model: PROMPT_MODEL });
  });

  it('caps the stored citations so the browse payload cannot blow up', async () => {
    // `answer_evidence` rides along on every row of GET /api/questions/catalogue,
    // which pages 50 questions at a time. A pathological generation citing every
    // line must not make that payload a function of how talkative the model felt.
    const own = Array.from({ length: 12 }, (_unused, index) => `own line ${index + 1}`);
    const { listener, answerService } = buildListener({
      recallService: { recall: jest.fn().mockResolvedValue(mixedRecallResult(own, [])) },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              first_person_evidence: Array.from({ length: 12 }, (_unused, index) => index + 1),
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const written = (answerService.create as jest.Mock).mock.calls[0][1];

    expect(written.answerEvidence.citations).toHaveLength(8);
    // The cut takes the tail, so the lines the model named first survive.
    expect(written.answerEvidence.citations[0].line).toBe(1);
  });

  it('truncates a long line rather than storing the whole thing', async () => {
    const long = `[I wrote, Mar 3, 2024] "${'x'.repeat(500)}"`;
    const { listener, answerService } = buildListener({
      recallService: { recall: jest.fn().mockResolvedValue(mixedRecallResult([long], [])) },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const written = (answerService.create as jest.Mock).mock.calls[0][1];

    expect(written.answerEvidence.citations[0].snippet).toHaveLength(280);
    // Verbatim as far as it goes: showing the owner something other than what
    // the model read would defeat the point of showing them anything.
    expect(long.startsWith(written.answerEvidence.citations[0].snippet)).toBe(true);
  });

  it('stores the lines the model was shown and did NOT cite, so the count has a list', async () => {
    // THE BUG. The drawer said "20 records were put in front of the model, 14 of
    // them your own" and then listed two, and the owner read the other eighteen
    // as withheld. They were not withheld — they were never kept. `linesShown`
    // was an integer with nothing behind it; this is what puts the rows there.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest.fn().mockResolvedValue(mixedRecallResult(['cited line', 'passed over'], ['their line'])),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: structuredResponse({ first_person_evidence: [1] }) },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const written = (answerService.create as jest.Mock).mock.calls[0][1];

    expect(written.answerEvidence.citations).toHaveLength(1);
    // Block order, and the SAME shape as a citation — the frontend renders both
    // groups through one reader, so a structural difference here would be a
    // second reader on the other side.
    expect(written.answerEvidence.uncited).toEqual([
      {
        line: 2,
        type: 'communication',
        id: 'own-2',
        at: '2024-03-02T00:00:00.000Z',
        voice: 'own',
        snippet: 'passed over',
      },
      {
        line: 3,
        type: 'communication',
        id: 'other-1',
        at: '2024-03-01T00:00:00.000Z',
        voice: 'other',
        snippet: 'their line',
      },
    ]);
  });

  it('keeps the inbound voice on an uncited line rather than flattening it', async () => {
    // The single most informative row in the group: a line that came back from
    // retrieval and was correctly NOT used is the speaker gate visibly working,
    // which is exactly what an owner auditing a wrong answer needs to see. Drop
    // the voice and it reads as a record the appliance simply ignored.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest.fn().mockResolvedValue(mixedRecallResult(['mine'], ['theirs', 'also theirs'])),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const written = (answerService.create as jest.Mock).mock.calls[0][1];

    expect(
      written.answerEvidence.uncited.map((line: { voice: string; id: string }) => [line.id, line.voice]),
    ).toEqual([
      ['other-1', 'other'],
      ['other-2', 'other'],
    ]);
  });

  it('never lists a line the model cited among the ones it passed over', async () => {
    // The two groups make opposite claims about the same answer. A line in both
    // would tell the owner a record supported the answer and was rejected by it.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest.fn().mockResolvedValue(mixedRecallResult(['a', 'b', 'c', 'd'], [])),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: structuredResponse({ first_person_evidence: [3, 1] }) },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const written = (answerService.create as jest.Mock).mock.calls[0][1];
    const cited = written.answerEvidence.citations.map((line: { line: number }) => line.line);
    const uncited = written.answerEvidence.uncited.map((line: { line: number }) => line.line);

    expect(cited).toEqual([3, 1]);
    // Block order for the leftovers, whatever order the citations came in.
    expect(uncited).toEqual([2, 4]);
    expect(uncited.filter((line: number) => cited.includes(line))).toEqual([]);
  });

  it('caps the stored uncited lines, and truncates them harder than a citation', async () => {
    // Same reasoning as the citation cap, with more force: this array is an
    // order of magnitude longer and rides the same 25-row browse page. A
    // citation is QUOTED as what the answer rests on and gets 280 characters; an
    // uncited line only has to be RECOGNISABLE, and gets 200.
    const long = `[I wrote, Mar 3, 2024] "${'x'.repeat(500)}"`;
    const own = ['cited', ...Array.from({ length: 40 }, () => long)];
    const { listener, answerService } = buildListener({
      recallService: { recall: jest.fn().mockResolvedValue(mixedRecallResult(own, [])) },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: structuredResponse({ first_person_evidence: [1] }) },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    const written = (answerService.create as jest.Mock).mock.calls[0][1];

    expect(written.answerEvidence.uncited).toHaveLength(24);
    expect(written.answerEvidence.uncited[0].snippet).toHaveLength(200);
    expect(long.startsWith(written.answerEvidence.uncited[0].snippet)).toBe(true);
    // The total is still the truth, so the drawer can admit the shortfall rather
    // than let the reader subtract and come out wrong.
    expect(written.answerEvidence.linesShown).toBe(41);
  });

  it('writes no evidence at all when the answer is discarded', async () => {
    // A discarded answer has no row to hang provenance off. Asserted because the
    // opposite — evidence persisted for an answer that was never written — would
    // be invisible until somebody opened a drawer on a question with no answer.
    const { listener, answerService } = buildListener({
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: { content: structuredResponse({ first_person_evidence: [] }) },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });
});

describe('AnswerInferenceListener.inferQuestionAnswer — the answer has to be ABOUT the person', () => {
  /** The measured line, verbatim: the owner describing an object they were building. */
  const OBJECT_LINE = '[I wrote, Nov 14, 2017] "It\'ll be like a foot tall."';

  it('writes nothing when the answer describes a thing instead of the person', async () => {
    // Live on the profile under "How tall are you?": own-voice evidence, a real
    // sentence, `stated` at 0.80 — every existing gate passed it.
    const { listener, answerService, personalizationService } = buildListener({
      recallService: { recall: jest.fn().mockResolvedValue(recallResult([OBJECT_LINE])) },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              asked_for: 'my height',
              support: 'stated',
              answer: "It'll be like a foot tall.",
              confidence: 0.9,
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
    expect(personalizationService.decideAction).not.toHaveBeenCalled();
  });

  it('writes nothing when the only line the claim rests on is a sentence about a thing', async () => {
    // The same failure with the tell edited out of the ANSWER — measured on the
    // next run of the same question, which returned "About a foot tall." off the
    // same single citation. The answer is the model's to phrase; the line it
    // rests on is not.
    const { listener, answerService } = buildListener({
      recallService: { recall: jest.fn().mockResolvedValue(recallResult([OBJECT_LINE])) },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              asked_for: 'my height',
              support: 'stated',
              first_person_evidence: [1],
              answer: 'About a foot tall.',
              confidence: 0.9,
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('DOES write when a cited line is genuinely about the person, even alongside a thing-sentence', async () => {
    // The other half, and what keeps the gate from being a blanket ban on lines
    // that mention an object: one real first-person line is enough.
    const { listener, answerService } = buildListener({
      recallService: {
        recall: jest
          .fn()
          .mockResolvedValue(recallResult([OBJECT_LINE, '[I wrote, Jan 2, 2018] "I am six foot two."'])),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              asked_for: 'my height',
              support: 'stated',
              first_person_evidence: [1, 2],
              answer: 'Six foot two.',
              confidence: 0.9,
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ text: 'Six foot two.' }),
    );
  });

  it('drops an answer about a thing even when its evidence is about the person', async () => {
    // Isolates the ANSWER-side gate from the evidence-side one: the cited line
    // here is a real first-person sentence, so the evidence gate passes it, and
    // the floor is at zero so nothing but this gate is left. It is the shape
    // "Are you more of a cat person or a dog person?" was published in.
    const reflection = config.reflection as { minAnswerConfidence: number };
    const originalFloor = reflection.minAnswerConfidence;
    reflection.minAnswerConfidence = 0;

    try {
      const { listener, answerService } = buildListener({
        recallService: {
          recall: jest
            .fn()
            .mockResolvedValue(recallResult(['[I wrote, May 3, 2016] "I used to have pets."'])),
        },
        ollamaService: {
          chat: jest.fn().mockResolvedValue({
            message: {
              content: structuredResponse({
                support: 'stated',
                answer: "It's like a mix between a dog and a cat.",
                confidence: 0.9,
              }),
            },
          }),
        },
      });

      await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

      expect(answerService.create).not.toHaveBeenCalled();
      expect(answerService.update).not.toHaveBeenCalled();
    } finally {
      reflection.minAnswerConfidence = originalFloor;
    }
  });
});

describe('AnswerInferenceListener.inferQuestionAnswer — the forced-choice commitment gate', () => {
  const forcedChoiceQuestion = {
    questionService: {
      findById: jest
        .fn()
        .mockResolvedValue(
          makeQuestion('q-1', 'Do you prefer small gatherings or large parties?', 'multiple_choice'),
        ),
    },
  };

  it('writes NOTHING for the measured live hedge — it names neither alternative', async () => {
    const { listener, answerService } = buildListener({
      ...forcedChoiceQuestion,
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              support: 'stated',
              answer: 'It depends on the parties I go to.',
              confidence: 0.75,
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
    expect(answerService.update).not.toHaveBeenCalled();
  });

  it('refuses the hedge even with the confidence floor set to zero', async () => {
    const reflection = config.reflection as { minAnswerConfidence: number };
    const originalFloor = reflection.minAnswerConfidence;
    reflection.minAnswerConfidence = 0;

    try {
      const { listener, answerService } = buildListener({
        ...forcedChoiceQuestion,
        ollamaService: {
          chat: jest.fn().mockResolvedValue({
            message: {
              content: structuredResponse({
                support: 'stated',
                answer: 'It depends on the parties I go to.',
                confidence: 0.75,
              }),
            },
          }),
        },
      });

      await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

      expect(answerService.create).not.toHaveBeenCalled();
    } finally {
      reflection.minAnswerConfidence = originalFloor;
    }
  });

  it('writes nothing when the answer names BOTH alternatives instead of choosing one', async () => {
    // Measured live on the neighbouring cat-or-dog question: a hedge can name
    // every option in the list and still not be a choice between them.
    const { listener, answerService } = buildListener({
      questionService: {
        findById: jest
          .fn()
          .mockResolvedValue(
            makeQuestion('q-1', 'Are you more of a cat person or a dog person?', 'multiple_choice'),
          ),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              support: 'stated',
              answer: "I am somewhere between cat and dog, though I currently take care of my neighbor's dogs.",
              confidence: 0.8,
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
  });

  it('still writes when the answer commits to one alternative, hedge and all', async () => {
    const { listener, answerService } = buildListener({
      questionService: {
        findById: jest
          .fn()
          .mockResolvedValue(makeQuestion('q-1', 'Do you prefer the beach or the mountains?', 'multiple_choice')),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              support: 'stated',
              answer: "I'm not sure, but I prefer the beach and nature areas.",
              confidence: 0.6,
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ text: "I'm not sure, but I prefer the beach and nature areas." }),
    );
  });

  it('does not touch a multiple_choice question that names no closed set of alternatives', async () => {
    const { listener, answerService } = buildListener({
      questionService: {
        findById: jest
          .fn()
          .mockResolvedValue(
            makeQuestion('q-1', 'What time of day do you prefer to exercise?', 'multiple_choice'),
          ),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({ support: 'stated', answer: 'Early morning.', confidence: 0.8 }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ text: 'Early morning.' }),
    );
  });

  it('leaves a question with no recorded type exactly where it was — no gate to apply', async () => {
    // Every pre-existing test in this file builds a question with no
    // `questionType` at all. This gate must be a constraint on a new field,
    // never a new way for those callers to lose an answer.
    const { listener, answerService } = buildListener({});

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalled();
  });
});

describe('AnswerInferenceListener.inferQuestionAnswer — the yes/no qualified-answer gate', () => {
  it('writes nothing when "it depends" restates the question instead of adding a condition', async () => {
    const { listener, answerService } = buildListener({
      questionService: {
        findById: jest
          .fn()
          .mockResolvedValue(
            makeQuestion('q-1', 'Do you prefer camping in a tent or staying in a hotel?', 'yes_no'),
          ),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              support: 'stated',
              answer: 'It depends on how I am camping that trip.',
              confidence: 0.7,
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).not.toHaveBeenCalled();
  });

  it('still writes a GENUINELY conditional yes/no answer — the false-positive case this gate must not create', async () => {
    const { listener, answerService } = buildListener({
      questionService: {
        findById: jest
          .fn()
          .mockResolvedValue(
            makeQuestion('q-1', 'Do you buy the extended warranty when it is offered?', 'yes_no'),
          ),
      },
      ollamaService: {
        chat: jest.fn().mockResolvedValue({
          message: {
            content: structuredResponse({
              support: 'stated',
              answer: 'It depends on the price.',
              confidence: 0.65,
            }),
          },
        }),
      },
    });

    await listener.inferQuestionAnswer({ ownerId: 'user-1', questionId: 'q-1' } as Payload);

    expect(answerService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ text: 'It depends on the price.' }),
    );
  });
});
