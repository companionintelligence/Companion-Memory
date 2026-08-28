import {
  ANSWER_SUPPORT_LEVELS,
  answersTheQuestion,
  calibrateInferredConfidence,
  confidenceLabel,
  CONFIDENCE_IMPLIED_CEILING,
  CONFIDENCE_NON_ANSWER,
  CONFIDENCE_OFF_QUESTION,
  CONFIDENCE_UNATTRIBUTED,
  DEFAULT_MIN_ANSWER_CONFIDENCE,
  enforceEvidenceIsAboutThePerson,
  enforceFirstPersonEvidence,
  enforceForcedChoiceCommitment,
  enforceYesNoQualifierIsInformative,
  estimateInferredAnswerConfidence,
  extractForcedChoiceAlternatives,
  INFERRED_ANSWER_JSON_SCHEMA,
  INFERRED_ANSWER_PROMPT_RULES,
  type InferredAnswer,
  isAboutSomethingElse,
  isNarratedVoice,
  isNonAnswer,
  normalizeAnswerSupport,
  normalizeEvidenceRefs,
  parseInferredAnswer,
  supportConfidenceCeiling,
  sanitizeInferredAnswerVoice,
} from '../inferredAnswerConfidence';

describe('estimateInferredAnswerConfidence', () => {
  it('scores thin context lower than rich RAG context', () => {
    expect(estimateInferredAnswerConfidence(0, false)).toBeLessThan(0.7);
    expect(estimateInferredAnswerConfidence(5, true)).toBeGreaterThanOrEqual(0.85);
  });

  it('raises the ceiling for evidence retrieved from the user’s own memory', () => {
    // The point of the RAG leg: an answer read off the user's records must be
    // allowed to outscore one invented from the same thin dossier, or widening
    // retrieval cannot change anything that reaches the database.
    expect(estimateInferredAnswerConfidence(0, false, 6)).toBeGreaterThan(
      estimateInferredAnswerConfidence(0, false, 0),
    );
    expect(estimateInferredAnswerConfidence(0, false, 6)).toBeGreaterThan(DEFAULT_MIN_ANSWER_CONFIDENCE);
  });

  it('leaves the ceiling untouched for callers that pass no retrieval count', () => {
    expect(estimateInferredAnswerConfidence(3, true)).toBe(estimateInferredAnswerConfidence(3, true, 0));
  });

  it('never exceeds the cap, however much evidence is piled on', () => {
    expect(estimateInferredAnswerConfidence(50, true, 50)).toBe(0.95);
  });
});

describe('parseInferredAnswer', () => {
  it('reads answer, confidence and rationale out of a clean structured response', () => {
    const parsed = parseInferredAnswer(
      '{"answer":"I mostly drink tea.","confidence":0.82,"rationale":"You said so in the coffee question."}',
    );

    expect(parsed).toEqual({
      answer: 'I mostly drink tea.',
      confidence: 0.82,
      rationale: 'You said so in the coffee question.',
    });
  });

  it('tolerates a markdown fence and leading prose around the JSON', () => {
    const parsed = parseInferredAnswer(
      'Sure! Here is the JSON:\n```json\n{"answer":"Blue.","confidence":0.5,"rationale":"Two prior answers."}\n```',
    );

    expect(parsed?.answer).toBe('Blue.');
    expect(parsed?.confidence).toBe(0.5);
  });

  it('rescales a percentage-style confidence into [0,1]', () => {
    // Models emit `85` for "85%" about as readily as `0.85`.
    expect(parseInferredAnswer('{"answer":"Yes.","confidence":85,"rationale":"x"}')?.confidence).toBe(0.85);
  });

  it('clamps an out-of-range confidence rather than storing it', () => {
    expect(parseInferredAnswer('{"answer":"Yes.","confidence":-3,"rationale":"x"}')?.confidence).toBe(0);
    expect(parseInferredAnswer('{"answer":"Yes.","confidence":400,"rationale":"x"}')?.confidence).toBe(1);
  });

  it('keeps the answer when the rationale is missing or blank, dropping the empty rationale', () => {
    expect(parseInferredAnswer('{"answer":"Yes.","confidence":0.6}')).toEqual({
      answer: 'Yes.',
      confidence: 0.6,
    });
    expect(parseInferredAnswer('{"answer":"Yes.","confidence":0.6,"rationale":"   "}')).toEqual({
      answer: 'Yes.',
      confidence: 0.6,
    });
  });

  it('returns null — never a substituted default — when confidence is absent or not a number', () => {
    // Inventing a score here would be the exact fabrication the floor exists to
    // prevent, so an unscored generation is a parse failure.
    expect(parseInferredAnswer('{"answer":"Yes.","rationale":"x"}')).toBeNull();
    expect(parseInferredAnswer('{"answer":"Yes.","confidence":"very","rationale":"x"}')).toBeNull();
  });

  it('returns null for an empty answer, prose, or unparseable content', () => {
    expect(parseInferredAnswer('{"answer":"   ","confidence":0.9}')).toBeNull();
    expect(parseInferredAnswer('I think you probably like tea.')).toBeNull();
    expect(parseInferredAnswer('')).toBeNull();
    expect(parseInferredAnswer('{"tasks": [}')).toBeNull();
  });
});

describe('isNonAnswer — the "nothing to share" shape', () => {
  // Measured live: written to the profile at 0.05 after the record-reference
  // rule shipped, because it names no record at all. The absent thing is the
  // very thing asked for, and the tell is the trailing "to share".
  it('flags a first-person refusal that names no record', () => {
    expect(isNonAnswer('I do not have a description of my sexual orientation to share.')).toBe(true);
    expect(isNonAnswer("I don't have any specific details to share.")).toBe(true);
    expect(isNonAnswer('I do not have an answer to give.')).toBe(true);
  });

  // The expensive direction. "I don't have a car" is a real answer to "do you
  // own a car?", and differs from the refusals above only by the missing
  // "to share" tail — which is why that tail is required rather than optional.
  it('leaves real answers of the same grammatical shape alone', () => {
    expect(isNonAnswer("I don't have a car.")).toBe(false);
    expect(isNonAnswer('I do not have any siblings.')).toBe(false);
    expect(isNonAnswer('I do not have a favorite.')).toBe(false);
  });
});

describe('isNonAnswer', () => {
  it.each([
    // The measured failure: perfect restaurant evidence, refused anyway.
    'I do not have this information recorded.',
    "I don't have this information recorded",
    'I don’t know.',
    'I do not know what my favourite cuisine is.',
    'I have no information about that.',
    "I don't have enough information to answer.",
    'I cannot determine that from the evidence.',
    "I don't recall.",
    'No information recorded.',
    'No data available for this question.',
    'Not recorded.',
    'Unknown',
    'N/A',
    'There is no information about this in the evidence.',
    'Nothing in the evidence speaks to this.',
    'The evidence does not mention any cuisine.',
    'Insufficient information.',
    'Sorry, I do not have this information recorded.',
    'As the user, I do not have any information about that.',
    'That information is not recorded.',
  ])('flags the refusal %p', (answer) => {
    expect(isNonAnswer(answer)).toBe(true);
  });

  it.each([
    // Real answers that merely start with a negative, or contain a refusal-ish
    // word. Discarding these would cost a genuine answer.
    "I don't drink coffee.",
    "I don't eat meat.",
    'None that I know of.',
    'No siblings.',
    'There is nothing I enjoy more than surfing.',
    'Nothing beats a long drive.',
    'Japanese, Mexican and Thai — I eat across all three.',
    'Los Angeles.',
    'Night owl',
    'Unknown Pleasures by Joy Division.',
    'Data engineering.',
    'I know a fair bit of Spanish.',
  ])('leaves the real answer %p alone', (answer) => {
    expect(isNonAnswer(answer)).toBe(false);
  });

  it('is not tripped by an empty string', () => {
    expect(isNonAnswer('')).toBe(false);
    expect(isNonAnswer('   ')).toBe(false);
  });
});

describe('isNonAnswer — refusals that report on the record instead of answering', () => {
  it.each([
    // The measured live miss. It names no "I don't know" phrase at all; what
    // makes it a refusal is that its subject is the record's silence, and it was
    // written to the owner's profile under "What pronouns do you use?".
    'I have not explicitly stated my pronouns in this record.',
    // Same shape with no mention of the record — the phrase guard, alone.
    'I have never explicitly stated my pronouns anywhere.',
    // The gap reported with the person's own attribute as the subject.
    'My blood type is not specified anywhere.',
    // Contracted, with a word between subject and verb: the pre-existing
    // "(?:does|do|did) not" guard let this through untouched.
    "The evidence here doesn't mention any of that.",
    // No enumerated phrase matches this one at all — it is caught structurally,
    // by being a claim of absence made about the record.
    'Nothing about my pronouns appears anywhere in this record.',
    'My favourite film is not something I have mentioned in these records.',
  ])('flags the record-report %p', (answer) => {
    expect(isNonAnswer(answer)).toBe(true);
  });

  it.each([
    // The live corpus's own good answers. Every one of these is a real thing the
    // owner would say, and the widened patterns must not cost any of them.
    'I am a night owl.',
    'Camarillo',
    'I am definitely a cat person.',
    'I sit on the board of an education charity called TAG and volunteer there.',
    "I've been studying English, Sign Language, and German, but I'm also interested in expanding my skills across many different languages.",
    'I grew up all over — San Diego, Yorba Linda, Seattle, and Anchorage; I am a military brat who changed schools often.',
    'Mexican and Indian cuisine is my usual go to, but I also adore Asian and French dishes.',
    // Reads like the refusal shapes above and is not one: "any specific food" is
    // the object, not "any information".
    "I don't have any specific food I refuse to eat under all circumstances.",
    // A negation next to a container word, which is why the structural rule
    // needs BOTH halves and keeps its noun list narrow.
    'I write everything down in my notes, never on paper.',
    'I keep my calendar empty on Fridays, no exceptions.',
  ])('leaves the real answer %p alone', (answer) => {
    expect(isNonAnswer(answer)).toBe(false);
  });
});

describe('sanitizeInferredAnswerVoice', () => {
  it('strips the narrator lead-in and leaves the person speaking', () => {
    // Measured live: written to the profile under "Which hobby have you kept the
    // longest…". The fact inside it is worth keeping; the narration is not.
    expect(
      sanitizeInferredAnswerVoice('My record shows I have maintained a strong interest in woodworking.'),
    ).toBe('I have maintained a strong interest in woodworking.');
    expect(sanitizeInferredAnswerVoice('Based on the evidence, I prefer the beach.')).toBe(
      'I prefer the beach.',
    );
    expect(sanitizeInferredAnswerVoice('According to my records, I fly out of LAX.')).toBe(
      'I fly out of LAX.',
    );
    // Narration with the corpus left implicit.
    expect(sanitizeInferredAnswerVoice('It appears that I prefer mornings.')).toBe('I prefer mornings.');
  });

  it('recapitalizes what is left when the lead-in took the sentence opening with it', () => {
    expect(sanitizeInferredAnswerVoice('The records indicate a long-standing interest in hockey.')).toBe(
      'A long-standing interest in hockey.',
    );
  });

  it('strips the same leak arriving as a tail', () => {
    expect(sanitizeInferredAnswerVoice('I prefer the beach, based on the evidence below.')).toBe(
      'I prefer the beach.',
    );
  });

  it('repairs mid-sentence narration of the retrieval itself', () => {
    // Measured live, inside an otherwise good answer to "In which city did you
    // spend most of your childhood?" — the list IS the answer, "listing
    // locations like" is the model describing its own lookup. A dash carries the
    // same sentence, so this is repaired rather than thrown away.
    const sanitized = sanitizeInferredAnswerVoice(
      'I grew up all over, listing locations like San Diego, Yorba Linda, Seattle, and Anchorage; I am a military brat.',
    );

    expect(sanitized).not.toContain('listing locations like');
    expect(sanitized).toBe(
      'I grew up all over — San Diego, Yorba Linda, Seattle, and Anchorage; I am a military brat.',
    );
  });

  it.each([
    'I am a night owl.',
    'Camarillo',
    'I am definitely a cat person.',
    'I sit on the board of an education charity called TAG and volunteer there.',
    // "in the data" is a job, not a citation — which is why the tail rule has no
    // bare "in"/"from" preposition.
    'I work in the data.',
    'Data engineering.',
  ])('leaves the real answer %p exactly as written', (answer) => {
    expect(sanitizeInferredAnswerVoice(answer)).toBe(answer);
  });
});

describe('isNarratedVoice', () => {
  it.each([
    // Narration woven into the claim: nothing can be stripped without rewriting
    // what the sentence says, so the row is dropped instead.
    'The user prefers mornings.',
    'A strong, ongoing interest in hobbies, per my records.',
    'My record shows a long-standing general interest in hobbies and supplies.',
    'This person tends to message their sister most.',
    'There is a clear pattern in the evidence of frequent hiking.',
    // The corpus named in passing — no citation frame, no narrator verb, still
    // the user talking about their database instead of their life.
    'Woodworking, though my records only go back a few years.',
    // 'data' is an ordinary word, so it only narrates when cited as a source…
    'Mostly Thai, based on the data.',
    // …or when it is the one doing the talking.
    'The data suggests I run in the mornings.',
    // Corpus-speak wherever it lands, not only as the subject.
    'Mostly Thai food, judging by what the user orders.',
  ])('flags the narrated answer %p', (answer) => {
    expect(isNarratedVoice(answer)).toBe(true);
  });

  it.each([
    'I am a night owl.',
    'Camarillo',
    'I am definitely a cat person.',
    'I grew up all over — San Diego, Yorba Linda, Seattle, and Anchorage; I am a military brat.',
    'I sit on the board of an education charity called TAG and volunteer there.',
    // Ordinary words that happen to name a kind of data.
    'Data engineering.',
    'I studied history at university.',
    'I am definitely more of a dog person than a cat person.',
    // "the person" mid-sentence is ordinary English; only corpus-speak is caught.
    "I'm the person everyone calls at 2am.",
    // What the sanitizer produces from a stripped lead-in must itself pass.
    'I have maintained a strong interest in woodworking.',
  ])('leaves the first-person answer %p alone', (answer) => {
    expect(isNarratedVoice(answer)).toBe(false);
  });

  it('is not tripped by an empty string', () => {
    expect(isNarratedVoice('')).toBe(false);
    expect(isNarratedVoice('   ')).toBe(false);
  });
});

describe('parseInferredAnswer — voice repair', () => {
  it('stores the answer in the user’s own voice, not the narrator’s', () => {
    const parsed = parseInferredAnswer(
      '{"answer":"My record shows I have kept up with woodworking for fifteen years.","confidence":0.6,"rationale":"Six workshop purchases."}',
    );

    expect(parsed?.answer).toBe('I have kept up with woodworking for fifteen years.');
    // The evidence still gets named — in the field whose job that is.
    expect(parsed?.rationale).toBe('Six workshop purchases.');
  });

  it('catches the refusal the narrator framing was hiding', () => {
    // Order matters: stripping runs BEFORE the non-answer check, so a refusal
    // wearing a lead-in is clamped like any other refusal instead of sailing
    // past on a phrase the pattern list never sees.
    const parsed = parseInferredAnswer(
      '{"answer":"Based on the evidence, there is no mention of pronouns.","confidence":0.8,"rationale":"x"}',
    );

    expect(parsed?.confidence).toBe(CONFIDENCE_NON_ANSWER);
  });
});

describe('parseInferredAnswer — non-answer confidence clamp', () => {
  it('clamps the exact measured failure: a refusal self-scored at 0.7', () => {
    // Retrieval handed the model three restaurant visits; it refused and then
    // scored the refusal 0.7, clearing the 0.4 floor meant to filter it out.
    // `confidence` means "how sure am I of this answer" — there is no answer
    // here, so the score is answering a different question and must not stand.
    const parsed = parseInferredAnswer(
      '{"answer":"I do not have this information recorded.","confidence":0.7,"rationale":"No line states a favorite cuisine."}',
    );

    expect(parsed?.confidence).toBe(CONFIDENCE_NON_ANSWER);
    expect(parsed?.confidence).toBeLessThan(0.2);
    expect(parsed?.confidence).toBeLessThan(DEFAULT_MIN_ANSWER_CONFIDENCE);
  });

  it('clamps a refusal that arrives as a percentage too', () => {
    expect(parseInferredAnswer('{"answer":"Unknown.","confidence":90,"rationale":"x"}')?.confidence).toBe(
      CONFIDENCE_NON_ANSWER,
    );
  });

  it('does not raise a refusal that already scored itself honestly low', () => {
    // Clamp, not assignment: an honest 0.05 stays 0.05.
    expect(
      parseInferredAnswer('{"answer":"I don\'t know.","confidence":0.05,"rationale":"x"}')?.confidence,
    ).toBe(0.05);
  });

  it('leaves a real synthesized answer at the score the model gave it', () => {
    const parsed = parseInferredAnswer(
      '{"answer":"Japanese, Mexican and Thai — I eat across all three.","confidence":0.55,"rationale":"Three restaurants in browser history."}',
    );

    expect(parsed?.confidence).toBe(0.55);
  });
});

describe('calibrateInferredConfidence', () => {
  it('caps an overconfident model at what the available evidence supports', () => {
    // No dossier, no related answers: the model saying 0.95 does not make it so.
    const ceiling = estimateInferredAnswerConfidence(0, false);

    expect(calibrateInferredConfidence(0.95, ceiling)).toBe(ceiling);
  });

  it('keeps an honestly low model score even when evidence was plentiful', () => {
    expect(calibrateInferredConfidence(0.2, estimateInferredAnswerConfidence(6, true))).toBe(0.2);
  });

  it('clamps a model score outside [0,1] before comparing', () => {
    expect(calibrateInferredConfidence(-1, 0.9)).toBe(0);
    expect(calibrateInferredConfidence(2, 0.9)).toBe(0.9);
  });

  it('can land below the default floor, which is what makes the refusal reachable', () => {
    expect(calibrateInferredConfidence(0.25, 0.9)).toBeLessThan(DEFAULT_MIN_ANSWER_CONFIDENCE);
  });
});

describe('confidenceLabel', () => {
  it('labels each band of the documented scale', () => {
    expect(confidenceLabel(0.95)).toBe('high');
    expect(confidenceLabel(0.9)).toBe('high');
    expect(confidenceLabel(0.75)).toBe('moderate');
    expect(confidenceLabel(0.4)).toBe('low');
    expect(confidenceLabel(0.1)).toBe('very low');
  });
});

describe('the prompt contract', () => {
  it('requires every field the parser reads, so a schema-constrained model emits all of them', () => {
    expect(INFERRED_ANSWER_JSON_SCHEMA.required).toEqual([
      'asked_for',
      'support',
      'first_person_evidence',
      'answer',
      'confidence',
      'rationale',
    ]);
  });

  it('declares the relevance judgement BEFORE the answer, so the answer is conditioned on it', () => {
    // Property order drives generation order under a schema-constrained
    // grammar. Declared after `answer`, `support` would be a label stuck on a
    // sentence already written — which is what the model does unprompted, and
    // what scored "There are doctors in my family." at 0.9 on a question about
    // hereditary conditions.
    const properties = Object.keys(INFERRED_ANSWER_JSON_SCHEMA.properties as Record<string, unknown>);

    expect(properties.indexOf('asked_for')).toBeLessThan(properties.indexOf('answer'));
    expect(properties.indexOf('support')).toBeLessThan(properties.indexOf('answer'));
  });

  it('states the scale to the model using the same numbers the code bands on', () => {
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('0.9');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('0.7');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('0.4');
  });

  it('asks for one short sentence or the bare fact, not a paragraph', () => {
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('ONE short first-person sentence');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('just the bare fact');
    expect(INFERRED_ANSWER_PROMPT_RULES).not.toContain('2-3 sentences');
  });

  it('routes uncertainty into the confidence score instead of into a hedging answer', () => {
    // The reported failure was a written answer reading "I'm not sure, I haven't
    // really thought about whether I prefer mornings or nights" — a non-answer
    // persisted as though the user had said it. The prompt must name that shape
    // and point it at the score instead.
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('NEVER hedge in the answer field');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain("I'm not sure");
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain("I haven't really thought about it");
  });

  it('separates inventing (forbidden) from inferring (the job)', () => {
    // The rules previously pushed only against fabrication, and the model read
    // that as "refuse unless a line says it outright" — so perfect evidence
    // produced "I do not have this information recorded."
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('SYNTHESIS, NOT LOOKUP');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('INVENTING');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('INFERRING');
    expect(INFERRED_ANSWER_PROMPT_RULES).toMatch(/indirect evidence is still evidence/i);
  });

  it('carries a worked example of the shape that was failing', () => {
    // Not decoration: the cuisine case is the measured failure, and showing the
    // correct output beside the wrong one is what makes the rule legible.
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('Japanese Cuisine');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('Thai Cuisine');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('I do not have this information recorded.');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('WRONG');
  });

  it('forbids narrating the corpus and names the leaks measured in production', () => {
    // "My record shows…" and "listing locations like…" were both written to the
    // owner's profile, where they read as the user describing their own data.
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('SPEAK AS THE PERSON');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('My record shows');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('based on the evidence');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('listing locations like');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('the user');
  });

  it('requires the answer to cover what the question actually asked', () => {
    // "Which hobby have you kept the longest, and for how many years?" came back
    // naming no hobby and no number — a sentence, but not an answer.
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('ANSWER EVERY PART THE QUESTION ACTUALLY ASKS');
    expect(INFERRED_ANSWER_PROMPT_RULES).toMatch(/vacuous/i);
  });

  it('tells the model a non-answer scores low, using the number the code clamps to', () => {
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('A NON-ANSWER MUST SCORE LOW');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain(`at most ${CONFIDENCE_NON_ANSWER}`);
    expect(CONFIDENCE_NON_ANSWER).toBeLessThan(0.2);
  });
});

describe('normalizeAnswerSupport', () => {
  it('accepts the documented levels in any casing or padding', () => {
    expect(normalizeAnswerSupport('stated')).toBe('stated');
    expect(normalizeAnswerSupport(' Implied ')).toBe('implied');
    expect(normalizeAnswerSupport('TOPICAL')).toBe('topical');
    expect(normalizeAnswerSupport('none')).toBe('none');
  });

  it('treats anything else as no judgement rather than as a failure', () => {
    // A strict enum in the zod schema would fail the WHOLE parse on a word like
    // "partial", throwing away a good answer over a label. An unreadable label
    // is an absent judgement, which is the pre-existing behaviour.
    expect(normalizeAnswerSupport('partial')).toBeUndefined();
    expect(normalizeAnswerSupport(undefined)).toBeUndefined();
    expect(normalizeAnswerSupport(3)).toBeUndefined();
  });
});

describe('answersTheQuestion', () => {
  it('rejects the two near-miss levels and nothing else', () => {
    expect(answersTheQuestion('stated')).toBe(true);
    expect(answersTheQuestion('implied')).toBe(true);
    expect(answersTheQuestion('topical')).toBe(false);
    expect(answersTheQuestion('none')).toBe(false);
  });

  it('treats a missing judgement as an answer, so callers that never ask are unaffected', () => {
    expect(answersTheQuestion(undefined)).toBe(true);
  });
});

describe('supportConfidenceCeiling', () => {
  it('caps an inference below the band the scale reserves for a stated fact', () => {
    expect(supportConfidenceCeiling('implied')).toBe(CONFIDENCE_IMPLIED_CEILING);
    expect(CONFIDENCE_IMPLIED_CEILING).toBeLessThan(0.9);
  });

  it('puts a near miss where a refusal sits, because it is the same event', () => {
    expect(supportConfidenceCeiling('topical')).toBe(CONFIDENCE_OFF_QUESTION);
    expect(supportConfidenceCeiling('none')).toBe(CONFIDENCE_OFF_QUESTION);
    expect(CONFIDENCE_OFF_QUESTION).toBeLessThan(DEFAULT_MIN_ANSWER_CONFIDENCE);
  });

  it('constrains neither a stated fact nor an absent judgement', () => {
    expect(supportConfidenceCeiling('stated')).toBe(1);
    expect(supportConfidenceCeiling(undefined)).toBe(1);
  });
});

describe('parseInferredAnswer — relevance clamp', () => {
  it('clamps a confident answer the model itself called topical', () => {
    // The measured live failure: "Which health conditions run in your immediate
    // family?" answered "There are doctors in my family." at 0.90, off evidence
    // that matched on 'family' and named no condition at all.
    const parsed = parseInferredAnswer(
      JSON.stringify({
        asked_for: 'named medical conditions occurring in my blood relatives',
        support: 'topical',
        answer: 'There are doctors in my family.',
        confidence: 0.9,
        rationale: 'doctors in my family.',
      }),
    );

    expect(parsed?.confidence).toBe(CONFIDENCE_OFF_QUESTION);
    expect(parsed?.support).toBe('topical');
    expect(parsed?.askedFor).toBe('named medical conditions occurring in my blood relatives');
  });

  it('clamps an implied answer out of the stated band', () => {
    expect(
      parseInferredAnswer('{"support":"implied","answer":"Thai.","confidence":0.95,"rationale":"x"}')
        ?.confidence,
    ).toBe(CONFIDENCE_IMPLIED_CEILING);
  });

  it('leaves a stated answer and an unlabelled one at the model’s own score', () => {
    expect(
      parseInferredAnswer('{"support":"stated","answer":"Camarillo","confidence":0.95,"rationale":"x"}')
        ?.confidence,
    ).toBe(0.95);
    expect(parseInferredAnswer('{"answer":"Camarillo","confidence":0.95,"rationale":"x"}')?.confidence).toBe(
      0.95,
    );
  });

  it('never RAISES a score to its ceiling', () => {
    expect(
      parseInferredAnswer('{"support":"stated","answer":"Camarillo","confidence":0.3,"rationale":"x"}')
        ?.confidence,
    ).toBe(0.3);
  });

  it('keeps the answer when the support label is a word it does not recognise', () => {
    const parsed = parseInferredAnswer(
      '{"support":"partial","answer":"Camarillo","confidence":0.9,"rationale":"x"}',
    );

    expect(parsed?.answer).toBe('Camarillo');
    expect(parsed?.confidence).toBe(0.9);
    expect(parsed?.support).toBeUndefined();
  });

  it('still clamps a refusal that labelled itself well supported', () => {
    expect(
      parseInferredAnswer(
        '{"support":"stated","answer":"I do not have this information recorded.","confidence":0.9,"rationale":"x"}',
      )?.confidence,
    ).toBe(CONFIDENCE_NON_ANSWER);
  });
});

describe('the prompt contract — relevance and cross-question bleed', () => {
  it('tells the model to answer the question asked, not the one the evidence answers', () => {
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain(
      'ANSWER THE QUESTION ASKED, NOT THE ONE THE EVIDENCE ANSWERS',
    );
    expect(INFERRED_ANSWER_PROMPT_RULES).toMatch(/near miss/i);
  });

  it('defines every support level the code enforces', () => {
    for (const level of ANSWER_SUPPORT_LEVELS) {
      expect(INFERRED_ANSWER_PROMPT_RULES).toContain(level);
    }
  });

  it('teaches confidence as how well the evidence answers THIS question, not how much came back', () => {
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('It is not how much evidence came back');
    expect(INFERRED_ANSWER_PROMPT_RULES).toMatch(/circle the topic without ever naming the thing/i);
  });

  it('carries the health-conditions near miss as a worked WRONG example', () => {
    // The worked examples are what the model actually generalises from; a rule
    // with no example beside it did not stop the 0.90 in the first place.
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('Which health conditions run in your immediate family?');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('There are doctors in my family.');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('Doctors are not conditions');
  });

  it('states that evidence does not transfer between neighbouring questions', () => {
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('EVIDENCE DOES NOT TRANSFER BETWEEN QUESTIONS');
    expect(INFERRED_ANSWER_PROMPT_RULES).toMatch(/speaking a language is not learning one/i);
    expect(INFERRED_ANSWER_PROMPT_RULES).toMatch(/prior answers to other questions are context/i);
  });
});

describe('normalizeEvidenceRefs', () => {
  it('reads the plain array a schema-constrained model emits', () => {
    expect(normalizeEvidenceRefs([2, 7])).toEqual([2, 7]);
  });

  it.each([
    [
      ['2', '7'],
      [2, 7],
    ],
    [
      ['E2', 'line 7'],
      [2, 7],
    ],
    ['2, 7', [2, 7]],
    [
      [2, 2, 7],
      [2, 7],
    ],
  ])('coerces %p to %p', (input, expected) => {
    expect(normalizeEvidenceRefs(input)).toEqual(expected);
  });

  it.each([undefined, null, {}, [null, true, 1.5]])('reads %p as no citation at all', (input) => {
    // A malformed citation must degrade to an ABSENT one, never to a parse
    // failure: absent is already the strictest verdict the gate has.
    expect(normalizeEvidenceRefs(input)).toEqual([]);
  });
});

describe('enforceFirstPersonEvidence — the speaker gate', () => {
  const answer = (overrides: Partial<Parameters<typeof enforceFirstPersonEvidence>[0]> = {}) => ({
    answer: 'I am definitely a cat person.',
    confidence: 0.95,
    support: 'stated' as const,
    firstPersonEvidence: [1],
    ...overrides,
  });

  it('passes an answer that cites one of the owner’s own lines', () => {
    const result = enforceFirstPersonEvidence(answer(), new Set([1, 2]));

    expect(result.grounded).toBe(true);
    expect(result.citedOwn).toEqual([1]);
    expect(result.inferred.support).toBe('stated');
    expect(result.inferred.confidence).toBe(0.95);
  });

  it.each([
    ['cites only inbound lines', [9, 10]],
    ['cites a line that is not in the block at all', [42]],
    ['cites nothing', []],
  ])('refuses `stated` on inbound-only evidence when the model %s', (_case, firstPersonEvidence) => {
    // The measured failure this exists for: "Are you more of a cat person or a
    // dog person?" → "I am definitely a cat person, and I have cats." at 0.95,
    // supported entirely by three OTHER people's messages about their cats.
    const result = enforceFirstPersonEvidence(answer({ firstPersonEvidence }), new Set([1, 2]));

    expect(result.grounded).toBe(false);
    expect(result.inferred.support).toBe('topical');
    expect(answersTheQuestion(result.inferred.support)).toBe(false);
    expect(result.inferred.confidence).toBeLessThanOrEqual(CONFIDENCE_UNATTRIBUTED);
  });

  it('refuses when the retrieval produced no first-person lines at all', () => {
    const result = enforceFirstPersonEvidence(answer(), new Set());

    expect(result.grounded).toBe(false);
    expect(result.inferred.support).toBe('topical');
  });

  it('refuses when the model omitted the field entirely', () => {
    // A model that predates the field, or one that dropped it, gets the strict
    // outcome — the opposite of `support`, where "no judgement" means "carry on".
    // An unproven first-person claim is the expensive mistake here.
    const { firstPersonEvidence: _omitted, ...withoutCitation } = answer();
    const result = enforceFirstPersonEvidence(withoutCitation, new Set([1]));

    expect(result.grounded).toBe(false);
  });

  it('never RAISES a confidence, only caps it', () => {
    const result = enforceFirstPersonEvidence(answer({ confidence: 0.02 }), new Set());

    expect(result.inferred.confidence).toBe(0.02);
  });
});

describe('the prompt contract — speaker attribution', () => {
  it('tells the model that an inbound line is somebody else talking', () => {
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain("OTHER PEOPLE'S WORDS ARE NOT THIS PERSON'S WORDS");
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('MY OWN RECORDS');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('WHAT OTHER PEOPLE SAID TO ME');
    expect(INFERRED_ANSWER_PROMPT_RULES).toMatch(/can never do is ESTABLISH/i);
  });

  it('asks for the citation BEFORE the answer, so the answer is conditioned on it', () => {
    const keys = INFERRED_ANSWER_JSON_SCHEMA.required as string[];

    expect(keys.indexOf('first_person_evidence')).toBeLessThan(keys.indexOf('answer'));
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('- first_person_evidence:');
  });

  it('does not hand the model a ready-made answer to a real catalogue question', () => {
    // The fabrication: the SPEAK AS THE PERSON example answered
    // "Woodworking — about fifteen years now." and the paragraph below it used
    // `longest_hobby`'s exact text as its illustration. Asked that question with
    // no hobby in the evidence, the model returned the example verbatim at 0.90,
    // rationale "The User Context section explicitly states …".
    expect(INFERRED_ANSWER_PROMPT_RULES).not.toContain('Woodworking');
    expect(INFERRED_ANSWER_PROMPT_RULES).not.toContain(
      'Which hobby have you kept the longest, and for how many years?',
    );
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('WORKED EXAMPLES ARE METHOD, NOT CONTENT');
  });
});

describe('isAboutSomethingElse — the aboutness gate', () => {
  it.each([
    // Both measured live on the reference corpus, both self-reported `stated`
    // at 0.80, both written by the owner about an OBJECT.
    ['a measurement of a thing offered as a body measurement', "It'll be like a foot tall."],
    ['a description of an animal offered as a preference', "It's like a mix between a dog and a cat."],
    ['the same sentence uncontracted', 'It is apparently like the halfway between a dog and cat.'],
    ['a demonstrative subject', 'That was about six inches across.'],
    ['a softened one', "Honestly, it's about a foot tall."],
    ['a curly apostrophe', 'It’ll be like a foot tall.'],
  ])('catches %s', (_case, answer) => {
    expect(isAboutSomethingElse(answer)).toBe(true);
  });

  it.each([
    // The eight answers that are correct on the reference corpus today. Losing
    // any of them to this gate would be a worse bug than the one it fixes.
    ['I sit on the board of an education charity called TAG and volunteer as much as I can.'],
    ["I'm a night owl."],
    ['Camarillo'],
    ['Mexican and Indian cuisine are my usual favorites, but I also adore a variety of Asian dishes.'],
    ['I grew up all over, including San Diego, Yorba Linda, Seattle, and Anchorage; I was a military brat.'],
    ['I sometimes watch hockey with friends.'],
    ['I prefer the beach and nature areas.'],
    ['I am currently exploring spirituality through resources like Spiritualize and Spiritual Path.'],
  ])('leaves the answer %s alone', (answer) => {
    expect(isAboutSomethingElse(answer)).toBe(false);
  });

  it('spares a sentence that opens impersonally and then says something about the person', () => {
    // The second clause is what makes it an answer, and it is the reason the
    // gate requires BOTH halves rather than matching on the opening alone.
    expect(isAboutSomethingElse("It's the house I grew up in.")).toBe(false);
    expect(isAboutSomethingElse('That was my first job.')).toBe(false);
  });

  it('spares a demonstrative that is a determiner rather than a subject', () => {
    // "This year" opens a real answer to a question about this year. Matching on
    // the bare word would throw it away.
    expect(isAboutSomethingElse('This year, mostly bouldering.')).toBe(false);
    expect(isAboutSomethingElse('That house in Camarillo.')).toBe(false);
  });

  it('is empty-safe', () => {
    expect(isAboutSomethingElse('')).toBe(false);
    expect(isAboutSomethingElse('   ')).toBe(false);
  });
});

describe('parseInferredAnswer — the aboutness clamp', () => {
  it('clamps an answer about an object however confidently the model argued for it', () => {
    // Verbatim from the live profile: the rationale asserts the line is a
    // height measurement, and the subject of the cited sentence is "It".
    const parsed = parseInferredAnswer(
      JSON.stringify({
        asked_for: 'my height',
        support: 'stated',
        first_person_evidence: [3],
        answer: "It'll be like a foot tall.",
        confidence: 0.8,
        rationale: 'The user stated a measurement of their height in their own records.',
      }),
    );

    expect(parsed?.answer).toBe("It'll be like a foot tall.");
    expect(parsed?.confidence).toBe(CONFIDENCE_OFF_QUESTION);
  });

  it('clamps the A-or-B answer that describes a thing that is part A and part B', () => {
    expect(
      parseInferredAnswer(
        JSON.stringify({
          support: 'stated',
          answer: "It's like a mix between a dog and a cat.",
          confidence: 0.8,
          rationale: 'which is a direct answer to the question',
        }),
      )?.confidence,
    ).toBe(CONFIDENCE_OFF_QUESTION);
  });

  it('leaves an answer about the person at the model’s own score', () => {
    expect(
      parseInferredAnswer(
        '{"support":"stated","answer":"I am six foot two.","confidence":0.9,"rationale":"x"}',
      )?.confidence,
    ).toBe(0.9);
  });
});

describe('the prompt contract — aboutness', () => {
  it('tells the model that writing a line is not the same as being what it is about', () => {
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain(
      'WRITTEN BY THIS PERSON IS NOT THE SAME AS ABOUT THIS PERSON',
    );
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('WHOSE PROPERTY IT NAMES');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('WHAT IT SUPPLIES');
  });

  it('scopes the rule to object-properties, so a line without the word "I" still counts', () => {
    // The measured cost of the first wording, which said the person had to be
    // the sentence's grammatical subject: "Do you prefer the beach or the
    // mountains?" — answered correctly for months off "Cuz the beach and nature
    // are here." — came back `topical`, rationale "this statement describes the
    // location's features rather than expressing a preference". A line is about
    // this person whenever their life is what is speaking.
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('This is NOT a demand that the word "I" appear');
    // And the illustration is invented, not the anchor's own evidence line —
    // an example naming the very record a catalogue question is scored on
    // would be teaching to the test.
    expect(INFERRED_ANSWER_PROMPT_RULES).not.toContain('Cuz the beach and nature are here');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('their life, their doing, their choice or their opinion');
  });

  it('carries both measured failures as worked WRONG cases with their correction', () => {
    // The teaching, not the incident: each WRONG line is paired with the
    // `topical` classification it should have carried.
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('How long is your beard?');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('Would you rather ride a kayak or a canoe?');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain(
      'An A-or-B question is answered by A or by B, never by a thing that is part A and part B',
    );
  });

  it('forbids the laundering move the model reached for next', () => {
    // Measured immediately after the answer-side gate closed the plain version:
    // the model rewrote the object's sentence in the first person and shipped
    // the same claim.
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain(
      'do NOT repair a sentence about a thing by changing its subject to "I"',
    );
  });

  it('illustrates them with subjects that are NOT in the question catalogue', () => {
    // The precedent: an earlier example used a real catalogue question's exact
    // text and the model returned the example's answer verbatim as a
    // fabrication. Both failures behind this section are catalogue questions —
    // `height` and `cat_or_dog_person` — so neither may appear here in the
    // words the model will be asked, nor may the answers they produced.
    expect(INFERRED_ANSWER_PROMPT_RULES).not.toContain('How tall are you?');
    expect(INFERRED_ANSWER_PROMPT_RULES).not.toContain('Are you more of a cat person or a dog person?');
    expect(INFERRED_ANSWER_PROMPT_RULES).not.toContain('a foot tall');
    expect(INFERRED_ANSWER_PROMPT_RULES).not.toContain('between a dog and a cat');
  });
});

describe('enforceEvidenceIsAboutThePerson — the evidence-side aboutness gate', () => {
  function answer(overrides: Partial<InferredAnswer> = {}): InferredAnswer {
    return {
      answer: 'About a foot tall.',
      confidence: 0.9,
      support: 'stated',
      firstPersonEvidence: [1],
      ...overrides,
    };
  }

  it('refuses a claim resting on a line whose SECOND sentence is the thing-sentence', () => {
    // "Sorry no.  It is apparently like the halfway between a dog and cat." —
    // the measured line behind the cat-or-dog answer, and the reason the line
    // test is per sentence: anchored at the line's start it reads as beginning
    // "no" and passes.
    const result = enforceEvidenceIsAboutThePerson(
      {
        answer: "I'm apparently somewhere between a dog person and a cat person.",
        confidence: 0.9,
        support: 'stated',
      },
      ['[I wrote, Dec 10, 2012] "Sorry no.  It is apparently like the halfway between a dog and cat."'],
    );

    expect(result.aboutThePerson).toBe(false);
    expect(result.inferred.support).toBe('topical');
  });

  it('leaves a multi-sentence line in which the person says something about themselves', () => {
    expect(
      enforceEvidenceIsAboutThePerson(
        { answer: 'I am more of a dog person.', confidence: 0.9, support: 'stated' },
        ['[I wrote, May 3, 2016] "It was a rough week. I used to have pets. Dogs, cats, birds."'],
      ).aboutThePerson,
    ).toBe(true);
  });

  it('refuses a claim whose every cited line is a sentence about a thing', () => {
    // The line is the constant across runs — one run of "How tall are you?"
    // answered "It'll be like a foot tall." and the next "About a foot tall.",
    // both citing this one line and nothing else.
    const result = enforceEvidenceIsAboutThePerson(answer(), [
      '[I wrote, Nov 14, 2017] "It\'ll be like a foot tall."',
    ]);

    expect(result.aboutThePerson).toBe(false);
    expect(result.inferred.support).toBe('topical');
    expect(answersTheQuestion(result.inferred.support)).toBe(false);
    expect(result.inferred.confidence).toBeLessThanOrEqual(CONFIDENCE_OFF_QUESTION);
  });

  it('accepts the claim when ANY cited line is about the person', () => {
    const result = enforceEvidenceIsAboutThePerson(answer(), [
      '[I wrote, Nov 14, 2017] "It\'ll be like a foot tall."',
      '[I wrote, Jan 2, 2018] "I am six foot two."',
    ]);

    expect(result.aboutThePerson).toBe(true);
    expect(result.inferred.support).toBe('stated');
    expect(result.inferred.confidence).toBe(0.9);
  });

  it.each([
    // Real citations behind answers that are CORRECT on the reference corpus.
    ['[I wrote, Aug 2, 2017] "Cuz the beach and nature are here."'],
    ['[I wrote, Jul 18, 2018] "lol, same. Night owl."'],
    ['Spiritualize — Lotus [2022-11-24T23:45:39.946Z]'],
    ['[Browser] Directions to Choya Japanese Cuisine, Dana Point, CA'],
  ])('leaves an activity record or a subject-less line alone: %s', (line) => {
    expect(enforceEvidenceIsAboutThePerson(answer(), [line]).aboutThePerson).toBe(true);
  });

  it('says nothing when there is nothing cited — that is the speaker gate’s verdict', () => {
    // `enforceFirstPersonEvidence` has already refused an uncited claim, and a
    // second refusal here would only mislabel WHY it was refused.
    const result = enforceEvidenceIsAboutThePerson(answer(), []);

    expect(result.aboutThePerson).toBe(true);
    expect(result.inferred.support).toBe('stated');
  });

  it('never RAISES a confidence, only caps it', () => {
    const result = enforceEvidenceIsAboutThePerson(answer({ confidence: 0.03 }), [
      '[I wrote, Nov 14, 2017] "It\'ll be like a foot tall."',
    ]);

    expect(result.inferred.confidence).toBe(0.03);
  });
});

describe('enforceEvidenceIsAboutThePerson — the subject-swap laundering shape', () => {
  /** The owner's real line: an animal somebody was describing to them. */
  const HYBRID_LINE =
    '[I wrote, Dec 10, 2012] "Sorry no.  It is apparently like the halfway between a dog and cat."';
  /** A second citation that IS about the person, so the all-lines test cannot fire. */
  const PERSONAL_LINE = '[I wrote, May 3, 2016] "I used to have pets. Dogs, cats, birds, fish."';

  function swapped(answer: string) {
    return enforceEvidenceIsAboutThePerson(
      { answer, confidence: 0.8, support: 'implied', firstPersonEvidence: [1, 2] },
      [HYBRID_LINE, PERSONAL_LINE],
    );
  }

  it('refuses the thing-sentence rewritten in the first person', () => {
    // Measured on the first run after the answer-side gate closed the plain
    // version: "I am apparently like the halfway between a dog and a cat." at
    // `implied` 0.80, off a citation set that is two-thirds legitimate.
    const result = swapped('I am apparently like the halfway between a dog and a cat.');

    expect(result.aboutThePerson).toBe(false);
    expect(result.inferred.support).toBe('topical');
    expect(result.inferred.confidence).toBeLessThanOrEqual(CONFIDENCE_OFF_QUESTION);
  });

  it.each([
    // Every phrasing the model reached for across four live runs of the same
    // question, once the plain copy stopped working.
    ["I'm a mix between a dog and a cat."],
    ['I am somewhere between a dog person and a cat person.'],
    ["I'm apparently somewhere between a dog person and a cat person."],
  ])('refuses the paraphrase %s', (answer) => {
    expect(swapped(answer).aboutThePerson).toBe(false);
  });

  it('leaves a real answer built from the same citations alone', () => {
    // What the same evidence should produce, and the reason the check needs both
    // a copula and a 70% claim overlap rather than either alone.
    expect(swapped('I am more of a dog person.').aboutThePerson).toBe(true);
    expect(swapped('I have owned both, but I look after my neighbour’s dogs now.').aboutThePerson).toBe(true);
    expect(swapped('Dogs.').aboutThePerson).toBe(true);
  });

  it('does not fire on a short predicate that happens to share words', () => {
    // "I am a night owl." is a correct answer on this corpus; two content words
    // are not a claim, and a rule that matched on them would be a coin toss. The
    // second citation is what keeps this test on the swap path — with the thing
    // sentence cited ALONE, the all-lines test refuses it for another reason.
    expect(
      enforceEvidenceIsAboutThePerson({ answer: 'I am a night owl.', confidence: 0.9, support: 'stated' }, [
        '[I wrote, Jun 1, 2016] "It is a night owl."',
        '[I wrote, Jun 25, 2010] "Really.  I am a night owl."',
      ]).aboutThePerson,
    ).toBe(true);
  });
});

describe('extractForcedChoiceAlternatives', () => {
  it('splits a plain "Do you prefer X or Y?" question into its two alternatives', () => {
    const alternatives = extractForcedChoiceAlternatives('Do you prefer the beach or the mountains?');

    expect(alternatives).not.toBeNull();
    expect(alternatives?.map((a) => a.tokens)).toEqual([['beach'], ['mountains']]);
  });

  it('drops the words every alternative shares, keeping only what distinguishes them', () => {
    // "person" is the topic, not a distinguishing word — this is what stops a
    // paraphrase that reuses only "person" ("I have cared for many kinds of
    // pets, and I'm definitely a people person") from being able to pass by
    // accident later.
    const alternatives = extractForcedChoiceAlternatives('Are you more of a cat person or a dog person?');

    expect(alternatives?.map((a) => a.tokens)).toEqual([['cat'], ['dog']]);
  });

  it('reads a three-way comma list, dropping the lead-in rather than counting it as a fourth option', () => {
    const alternatives = extractForcedChoiceAlternatives(
      'Do you keep your phone on silent, vibrate, or ringer?',
    );

    expect(alternatives?.map((a) => a.tokens)).toEqual([['silent'], ['vibrate'], ['ringer']]);
  });

  it('drops a lead-in that trims to nothing rather than treating it as an alternative', () => {
    // "What kind of stove do you cook on" ends in the stopword "on" — the
    // trailing run is empty, so it is dropped instead of surfacing "cook" as a
    // fourth, nonsensical option alongside gas/electric/induction.
    const alternatives = extractForcedChoiceAlternatives(
      'What kind of stove do you cook on, gas, electric, or induction?',
    );

    expect(alternatives?.map((a) => a.tokens)).toEqual([['gas'], ['electric'], ['induction']]);
  });

  it.each([
    // Open-domain multiple_choice: no " or " to split on at all.
    ['What time of day do you prefer to exercise?'],
    ['What day of the week is your usual day off?'],
    // A quantity question that HAPPENS to contain a clean " or " split — the
    // real trap this session's sampling turned up. "therapy" and "counseling
    // appointments" are the same category said two ways, and the question
    // wants a frequency, not a pick between them.
    ['How often do you have therapy or counseling appointments?'],
    ['What time do you usually leave for work or school?'],
  ])('names no alternatives for %s', (text) => {
    expect(extractForcedChoiceAlternatives(text)).toBeNull();
  });

  it('refuses a split where the two sides reduce to the same words', () => {
    expect(extractForcedChoiceAlternatives('Do you prefer tea or tea?')).toBeNull();
  });

  it('refuses a split that would leave more than four alternatives', () => {
    expect(
      extractForcedChoiceAlternatives('Do you prefer red, blue, green, yellow, or purple?'),
    ).toBeNull();
  });
});

describe('enforceForcedChoiceCommitment — the forced-choice commitment gate', () => {
  function answer(overrides: Partial<InferredAnswer> = {}): InferredAnswer {
    return { answer: 'It depends.', confidence: 0.9, ...overrides };
  }

  it('is a no-op for anything other than multiple_choice', () => {
    const result = enforceForcedChoiceCommitment(
      answer({ answer: 'It depends on the parties I go to.' }),
      { text: 'Do you prefer small gatherings or large parties?', questionType: 'yes_no' },
    );

    expect(result.committed).toBe(true);
    expect(result.alternatives).toBeNull();
    expect(result.inferred.confidence).toBe(0.9);
  });

  it('is a no-op when the question does not cleanly name a closed set', () => {
    const result = enforceForcedChoiceCommitment(answer({ answer: 'Around 7am, usually.' }), {
      text: 'What time of day do you prefer to exercise?',
      questionType: 'multiple_choice',
    });

    expect(result.committed).toBe(true);
    expect(result.alternatives).toBeNull();
  });

  it('discards the measured live failure — a hedge that restates the axis without picking a side', () => {
    const result = enforceForcedChoiceCommitment(
      answer({ answer: 'It depends on the parties I go to.', confidence: 0.75, support: 'stated' }),
      { text: 'Do you prefer small gatherings or large parties?', questionType: 'multiple_choice' },
    );

    expect(result.committed).toBe(false);
    expect(result.inferred.support).toBe('topical');
    expect(result.inferred.confidence).toBeLessThanOrEqual(CONFIDENCE_OFF_QUESTION);
    expect(answersTheQuestion(result.inferred.support)).toBe(false);
  });

  it('discards a paraphrase that names the shared topic word but neither distinguishing word', () => {
    // "the parties I go to" contains "parties" — one of "large parties"'s two
    // words — without ever saying "large". A single-word check would wave
    // this through; the gate requires ALL of an alternative's own words.
    const result = enforceForcedChoiceCommitment(
      answer({ answer: 'It depends on the parties I go to.' }),
      { text: 'Do you prefer small gatherings or large parties?', questionType: 'multiple_choice' },
    );

    expect(result.committed).toBe(false);
  });

  it('discards an answer that names BOTH alternatives — that is a hedge, not a choice', () => {
    // Measured live, on the same question: "I am somewhere between cat and
    // dog, though I currently take care of my neighbor's dogs." contains the
    // literal words "cat" AND "dog" — an "at least one" check would pass it.
    const result = enforceForcedChoiceCommitment(
      answer({
        answer: "I am somewhere between cat and dog, though I currently take care of my neighbor's dogs.",
        confidence: 0.8,
        support: 'stated',
      }),
      { text: 'Are you more of a cat person or a dog person?', questionType: 'multiple_choice' },
    );

    expect(result.committed).toBe(false);
    expect(result.inferred.support).toBe('topical');
  });

  it('keeps a real commitment that also hedges', () => {
    // The case a phrase-ban on hedges would have broken: this answer hedges
    // AND commits, and the gate must let it through unchanged.
    const result = enforceForcedChoiceCommitment(
      answer({ answer: "I'm not sure, but I prefer the beach and nature areas.", confidence: 0.6 }),
      { text: 'Do you prefer the beach or the mountains?', questionType: 'multiple_choice' },
    );

    expect(result.committed).toBe(true);
    expect(result.inferred).toEqual(answer({ answer: "I'm not sure, but I prefer the beach and nature areas.", confidence: 0.6 }));
  });

  it('keeps a short, direct commitment', () => {
    const result = enforceForcedChoiceCommitment(answer({ answer: "I'm a night owl.", confidence: 0.9 }), {
      text: 'Are you a morning person or a night owl?',
      questionType: 'multiple_choice',
    });

    expect(result.committed).toBe(true);
  });

  it('matches across a simple inflection, so a real commitment is not lost to a verb form', () => {
    // Measured against a fresh answer from the live corpus: "travel" in the
    // question, "traveling" in the answer.
    const result = enforceForcedChoiceCommitment(
      answer({ answer: 'I prefer traveling with a carry-on.', confidence: 0.95 }),
      { text: 'Do you check a bag or travel carry-on only?', questionType: 'multiple_choice' },
    );

    expect(result.committed).toBe(true);
  });

  it('never RAISES a confidence, only caps it', () => {
    const result = enforceForcedChoiceCommitment(answer({ answer: 'It depends.', confidence: 0.03 }), {
      text: 'Do you prefer the beach or the mountains?',
      questionType: 'multiple_choice',
    });

    expect(result.inferred.confidence).toBe(0.03);
  });
});

describe('enforceYesNoQualifierIsInformative — the yes/no qualified-answer gate', () => {
  function answer(overrides: Partial<InferredAnswer> = {}): InferredAnswer {
    return { answer: 'It depends.', confidence: 0.65, ...overrides };
  }

  it('is a no-op for anything other than yes_no', () => {
    const result = enforceYesNoQualifierIsInformative(
      answer({ answer: 'It depends on the parties I go to.' }),
      { text: 'Do you prefer small gatherings or large parties?', questionType: 'multiple_choice' },
    );

    expect(result.informative).toBe(true);
    expect(result.inferred.confidence).toBe(0.65);
  });

  it('is a no-op when the answer never says "it depends" at all', () => {
    const result = enforceYesNoQualifierIsInformative(answer({ answer: 'Yes, always.' }), {
      text: 'Do you buy the extended warranty when it is offered?',
      questionType: 'yes_no',
    });

    expect(result.informative).toBe(true);
  });

  it('leaves a GENUINELY conditional answer alone — the false-positive case this gate must not create', () => {
    // Point 2 of the design: "it depends" is not always the same defect as the
    // multiple_choice hedge. Price is a real variable "Do you buy the
    // extended warranty when it is offered?" never named, so naming it is new
    // information, not a restatement.
    const result = enforceYesNoQualifierIsInformative(
      answer({ answer: 'It depends on the price.', confidence: 0.65, support: 'stated' }),
      { text: 'Do you buy the extended warranty when it is offered?', questionType: 'yes_no' },
    );

    expect(result.informative).toBe(true);
    expect(result.inferred.confidence).toBe(0.65);
    expect(result.inferred.support).toBe('stated');
  });

  it('discards a circular "it depends" that just restates the question\'s own subject', () => {
    // The yes_no mirror of the multiple_choice bug: the condition offered is
    // not a new variable, it is the choice itself said back.
    const result = enforceYesNoQualifierIsInformative(
      answer({
        answer: 'It depends on how I am camping that trip.',
        confidence: 0.7,
        support: 'stated',
      }),
      { text: 'Do you prefer camping in a tent or staying in a hotel?', questionType: 'yes_no' },
    );

    expect(result.informative).toBe(false);
    expect(result.inferred.support).toBe('topical');
    expect(result.inferred.confidence).toBeLessThanOrEqual(CONFIDENCE_OFF_QUESTION);
  });

  it('discards a bare "it depends" with no stated condition at all', () => {
    const result = enforceYesNoQualifierIsInformative(answer({ answer: 'It depends.' }), {
      text: 'Do you buy the extended warranty when it is offered?',
      questionType: 'yes_no',
    });

    expect(result.informative).toBe(false);
  });

  it('discards a qualifier that names a hollow category instead of an actual condition', () => {
    const result = enforceYesNoQualifierIsInformative(
      answer({ answer: 'It really depends on the situation.' }),
      { text: 'Do you buy the extended warranty when it is offered?', questionType: 'yes_no' },
    );

    expect(result.informative).toBe(false);
  });

  it('never RAISES a confidence, only caps it', () => {
    const result = enforceYesNoQualifierIsInformative(answer({ answer: 'It depends.', confidence: 0.03 }), {
      text: 'Do you buy the extended warranty when it is offered?',
      questionType: 'yes_no',
    });

    expect(result.inferred.confidence).toBe(0.03);
  });
});

describe('the prompt contract — forced-choice commitment', () => {
  it('teaches the rule with an invented subject, never the real catalogue questions it was measured on', () => {
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('FORCED CHOICE IS NOT ANSWERED BY ORBITING THE CHOICE');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('camping in a tent or in a hammock');
    expect(INFERRED_ANSWER_PROMPT_RULES).not.toContain('Do you prefer small gatherings or large parties?');
    expect(INFERRED_ANSWER_PROMPT_RULES).not.toContain('Are you more of a cat person or a dog person?');
    expect(INFERRED_ANSWER_PROMPT_RULES).not.toContain('It depends on the parties I go to');
  });

  it('distinguishes a genuine condition from a circular one', () => {
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('CONDITION IS ACTUALLY NEW');
    expect(INFERRED_ANSWER_PROMPT_RULES).toContain('It depends on the weather.');
  });
});
