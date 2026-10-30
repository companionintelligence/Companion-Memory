import { Injectable } from '@nestjs/common';

import { type ServiceContext, type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import { type RecallLine, RecallService } from '@ci/domains/agent';
import { type Acknowledgement, Events, type EventPayloads, OnEvent } from '@ci/domains/events';
import {
  Answer,
  type AnswerEvidence,
  type AnswerEvidenceCitation,
  AnswerService,
  QuestionService,
} from '@ci/domains/intelligence';
import {
  answersTheQuestion,
  calibrateInferredConfidence,
  confidenceLabel,
  enforceEvidenceIsAboutThePerson,
  enforceFirstPersonEvidence,
  enforceForcedChoiceCommitment,
  enforceYesNoQualifierIsInformative,
  estimateInferredAnswerConfidence,
  INFERRED_ANSWER_JSON_SCHEMA,
  INFERRED_ANSWER_PROMPT_RULES,
  type InferredAnswer,
  isAboutSomethingElse,
  isNarratedVoice,
  isNonAnswer,
  LLM_BACKGROUND_QUEUE,
  LLM_BACKGROUND_QUEUE_OPTIONS,
  OllamaService,
  parseInferredAnswer,
  PROMPT_MODEL,
} from '@ci/domains/llm';
import { PersonalizationService } from '@ci/domains/personalization';
import { SearchService } from '@ci/domains/search-next';

import { INFERENCE_QUEUE_RETENTION_MINUTES } from './SmartRotationListener';

const RELATED_ANSWER_LIMIT = 10;
const RECENT_ANSWER_FALLBACK = 5;

/**
 * Output cap (Ollama `options.num_predict`). The schema's `answer` is
 * documented as "ONE short first-person sentence at most" and `rationale` as
 * "one line" — generous headroom over a legitimate response, sized only to
 * stop runaway generation, not to shape a real one.
 */
const INFERENCE_MAX_OUTPUT_TOKENS = 800;

/**
 * Keep the model resident across the run (Ollama `keep_alive`). Answer
 * inference fires per-question on the single-slot LLM_BACKGROUND_QUEUE next to
 * title generation, so an hour keeps it warm across that traffic rather than
 * reloading it inside this call's own budget.
 */
const INFERENCE_KEEP_ALIVE = '1h';

/**
 * Seed hits to pull from the user's OWN indexed memory for the question.
 *
 * Deliberately small. This is the whole corpus — communications, events,
 * content, browser activity, people, files — so recall is not the constraint;
 * prompt discipline is. RecallService unions one hop of query-relevant graph
 * expansion on top of these seeds, so the block that reaches the model is
 * usually a little longer than this number.
 */
const MEMORY_EVIDENCE_SEEDS = 8;

/**
 * How many "somebody else said this to me" lines are allowed into the prompt.
 *
 * They are kept rather than filtered out because they are real context: an
 * inbound "happy birthday!" genuinely evidences a birthday, and the question
 * somebody asked is what this person's own reply is answering. What they may
 * never do is CARRY the claim — {@link enforceFirstPersonEvidence} is what makes
 * that structural rather than advisory.
 *
 * Capped because 52% of this corpus (168,385 of 325,153 rows) is other people
 * talking, so an uncapped share of the block crowds out the handful of lines
 * that can actually answer the question. Rank order is preserved, so the cut
 * takes the tail.
 */
const OTHER_VOICE_EVIDENCE_LIMIT = 6;

/**
 * How many cited rows are written onto the answer.
 *
 * The model cites one to three lines in practice, so this is a ceiling against a
 * pathological generation rather than a working limit. It exists because
 * `answer_evidence` rides along on every row of `GET /api/questions/catalogue`,
 * which pages fifty questions at a time: unbounded citations would make the
 * browse payload a function of how talkative the model felt.
 */
const MAX_STORED_CITATIONS = 8;

/**
 * Longest stored snippet, in characters.
 *
 * The lines themselves are already short — SerializerService caps a message at
 * 200 characters — so this only bites on a graph-expansion line that concatenated
 * several descriptions. Same payload reasoning as {@link MAX_STORED_CITATIONS}.
 */
const MAX_STORED_SNIPPET = 280;

/**
 * How many retrieved-but-UNCITED rows are written onto the answer.
 *
 * The block is bounded by construction — {@link MEMORY_EVIDENCE_SEEDS} own
 * seeds, one hop of query-relevant graph expansion, and at most
 * {@link OTHER_VOICE_EVIDENCE_LIMIT} inbound lines — so this is a ceiling, not a
 * working limit, in exactly the way {@link MAX_STORED_CITATIONS} is. Measured on
 * the reference appliance, `linesShown` across every stored row was 16, 20, 21
 * and 23, against one or two citations each: 15 to 22 uncited. 24 covers all of
 * them, so the group the owner reads is the whole retrieval and the "and N more
 * were read" caveat never fires in practice.
 *
 * Not unbounded, because this rides on every row of `GET
 * /api/questions/catalogue`, which the frontend pages 25 at a time
 * (CATALOGUE_PAGE_SIZE). Measured after this landed: a real row —
 * `birth_city`, 2 citations and 19 uncited lines — is 2.7KB of jsonb, so a page
 * on which every question is answered and inferred costs ~68KB. The worst case
 * the caps allow is ~7.7KB a row (~190KB a page); an uncapped graph expansion
 * would make it a function of how connected the query happened to be, which is
 * not a number anybody can reason about.
 */
const MAX_STORED_UNCITED = 24;

/**
 * Longest stored snippet for an UNCITED row, in characters.
 *
 * Shorter than {@link MAX_STORED_SNIPPET} on purpose, and it is a different job:
 * a citation is QUOTED back as the thing the answer rests on, while an uncited
 * row is listed so the owner can RECOGNISE it and see it was passed over. 200 is
 * where the real distribution already ends — SerializerService caps a serialized
 * message at 200 characters — so the 280 on citations is headroom for a
 * concatenated graph-expansion line, and a line the model did not use does not
 * need that headroom twenty-four times over.
 */
const MAX_STORED_UNCITED_SNIPPET = 200;

/**
 * The EVIDENCE section as the model sees it, plus the bookkeeping this side
 * needs to check the model's citations against it.
 */
interface ComposedEvidence {
  /** The prompt-ready block: two headed sections of numbered lines. */
  block: string;
  /** Line numbers that are the owner's OWN words or actions. The gate's key. */
  ownLineNumbers: Set<number>;
  /**
   * Every numbered line, by the number the model sees.
   *
   * The numbering is assigned HERE — it is a property of the block, not of the
   * retrieval — so this map is the only place a citation like `[2, 7]` can be
   * turned back into the rows it points at. Without it the model's citations are
   * checkable (the gate only needs the number set) but not RECORDABLE.
   */
  linesByNumber: Map<number, RecallLine>;
  /** How many first-person lines the retrieval actually produced. */
  ownCount: number;
  /** Every line put in front of the model, first-person or not. */
  shownCount: number;
}

/**
 * What one inference run decided, without saying anything about persistence.
 *
 * `discarded` carries the reason and — where the model got far enough to
 * produce one — the answer that was thrown away, so a probe or a log reader can
 * see WHAT was rejected and not only that something was.
 */
export type InferenceOutcome =
  | { status: 'ok'; inferred: InferredAnswer; confidence: number; evidence: AnswerEvidence }
  | {
      status: 'discarded';
      reason: string;
      inferred?: InferredAnswer;
      confidence?: number;
    };

/**
 * Why a queued job was dropped before any retrieval or model call.
 *
 * `gone` is the row vanishing between the listener's two reads of it; the other
 * three are the filters both inference selectors apply when they queue a job
 * (see {@link QuestionService.findInferenceStanding}).
 */
type InferenceSkipReason = 'gone' | 'inactive' | 'hand-entry' | 'forked';

@Injectable()
export class AnswerInferenceListener {
  constructor(
    private readonly answerService: AnswerService,
    private readonly questionService: QuestionService,
    private readonly searchService: SearchService,
    private readonly recallService: RecallService,
    private readonly personalizationService: PersonalizationService,
    private readonly ollamaService: OllamaService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AnswerInferenceListener.name);
  }

  /**
   * The queue's entry point: drop a job that waited too long, run the rest.
   *
   * ═══ WHY A JOB CAN BE TOO OLD TO RUN ═══
   *
   * An inference is a guess at one unanswered question, and the selectors make
   * a fresh guess every interval, so a job is only worth its GPU time while it
   * is current. Measured on core-1, 2026-10-17: four owners at one job a minute
   * each against one `ollama-background` slot. The queue fell ~4 h behind — a
   * job created at 23:01 UTC started at 02:56 — with 941 waiting, and every one
   * of them would have been run, oldest first, long after anyone wanted it.
   *
   * The dispatch gate (`inferenceDispatchGate.ts`) stops a backlog forming, and
   * new sends carry {@link INFERENCE_QUEUE_RETENTION_MINUTES} so pg-boss drops
   * them unstarted. This is the third leg, for whatever reaches a worker anyway:
   * a backlog queued before either existed (90-day retention, so it would
   * otherwise replay in full on the next start), or a job fetched just before
   * its retention ran out. Same number, same meaning: past it the job is
   * completed without work — one log line, no retrieval, no model call — and
   * the selector, which reads the completed row as an attempt, moves on.
   *
   * Measured from `enqueuedAt` (the row's `created_on`), so a retry keeps its
   * place in the clock and a dead-letter replay, which is a NEW job, is not
   * stale on arrival. No `enqueuedAt` (LocalEventService) means nothing waited.
   *
   * {@link inferQuestionAnswer} stays the unacknowledged work itself, which is
   * what tests and probes call directly.
   */
  @OnEvent(Events.INFER_QUESTION_ANSWER, {
    queue: LLM_BACKGROUND_QUEUE,
    queueOptions: LLM_BACKGROUND_QUEUE_OPTIONS,
    autoAcknowledge: false,
  })
  async handleInferQuestionAnswer(
    payload: EventPayloads[Events.INFER_QUESTION_ANSWER],
    ack: Acknowledgement,
  ): Promise<void> {
    const waitedMs = ack.enqueuedAt ? Date.now() - ack.enqueuedAt.getTime() : 0;

    if (waitedMs > INFERENCE_QUEUE_RETENTION_MINUTES * 60_000) {
      this.logger.log('Answer inference dropped — the job waited longer than it is worth', {
        userId: payload.ownerId,
        questionId: payload.questionId,
        waitedMinutes: Math.round(waitedMs / 60_000),
        limitMinutes: INFERENCE_QUEUE_RETENTION_MINUTES,
      });
      ack.done();

      return;
    }

    try {
      await this.inferQuestionAnswer(payload);
      ack.done();
    } catch (error) {
      ack.fail(error);
    }
  }

  async inferQuestionAnswer(payload: EventPayloads[Events.INFER_QUESTION_ANSWER]) {
    const ownerId = payload.ownerId;
    if (!ownerId) {
      this.logger.warn('Answer inference skipped — no user owner', {
        questionId: payload.questionId,
      });

      return;
    }

    this.logger.log('Inferring answer to question', {
      userId: ownerId,
      questionId: payload.questionId,
    });

    const serviceContext = { userId: ownerId } as UserServiceContext;

    const question = await this.questionService.findById(serviceContext, payload.questionId);

    if (!question) {
      return;
    }

    // ═══ THE EXECUTION-TIME GATE ═══
    //
    // `findById` settles who may READ the row and nothing else. The selectors
    // that queue this job also require the question to be active, not
    // `hand_entry`, and not replaced by one of the owner's own forks — but they
    // check that when they QUEUE it, and a job waits in pg-boss, behind the
    // single-slot LLM queue, before anything runs it. In that gap a migration can
    // retire the row, a reclassification can mark it `hand_entry`, and the owner
    // can fork it, and nothing in the payload knows. Unchecked, the job ran the
    // model anyway and wrote an inferred answer onto a question the owner is no
    // longer asked.
    //
    // Here, and not in `inferAnswerForQuestion`: that is what a probe or a test
    // calls to inspect the model's decision without writing anything, and gating
    // it would stop a probe from asking about a hand-entry question at all.
    const skipReason = await this.findSkipReason(serviceContext, question.id);

    if (skipReason) {
      this.logger.debug('Answer inference skipped — the question no longer qualifies', {
        userId: ownerId,
        questionId: payload.questionId,
        reason: skipReason,
      });

      return;
    }

    const outcome = await this.inferAnswerForQuestion(serviceContext, question);

    if (outcome.status !== 'ok') {
      return;
    }

    const { inferred, confidence, evidence } = outcome;

    await this.persistInferredAnswer(serviceContext, payload.questionId, inferred, confidence, evidence);
  }

  /**
   * Why a queued job must not run any more, or null when the question still
   * qualifies.
   *
   * Reads the three facts fresh from `ci.questions` and decides here, so the
   * decision is this listener's and the SQL stays the service's. The order is
   * only the order the reason is reported in: a retired question the owner has
   * also forked is `inactive`, and either way the job does not run.
   */
  private async findSkipReason(
    serviceContext: UserServiceContext,
    questionId: string,
  ): Promise<InferenceSkipReason | null> {
    const standing = await this.questionService.findInferenceStanding(serviceContext, questionId);

    // Readable a moment ago and not now: deleted between the two reads.
    if (!standing) {
      return 'gone';
    }

    if (!standing.isActive) {
      return 'inactive';
    }

    // A deny-list, as in both selectors (`evidence_class <> 'hand_entry'`): a
    // class added later stays inferable until somebody says it is not.
    if (standing.evidenceClass === 'hand_entry') {
      return 'hand-entry';
    }

    if (standing.forkedByCaller) {
      return 'forked';
    }

    return null;
  }

  /**
   * Everything between "here is a question" and "write a row": retrieval, the
   * prompt, the model call, and every gate that can discard the result.
   *
   * Split out of {@link inferQuestionAnswer} so the decision and the write are
   * separable — the event handler persists, a probe or a test can inspect the
   * same decision without touching ci.answers.
   */
  async inferAnswerForQuestion(
    serviceContext: UserServiceContext,
    // `questionType` is optional so a caller that predates the forced-choice
    // gates (a test, a probe) keeps building a valid argument without it —
    // both gates below treat a missing type as "not applicable" the same way
    // they treat a type that is neither 'multiple_choice' nor 'yes_no'.
    question: { id: string; text: string; questionType?: string | null },
  ): Promise<InferenceOutcome> {
    const ownerId = serviceContext.userId;
    const resolvedAnswers = await this.findRelatedAnswers(serviceContext, question.text, question.id);

    // The actual RAG leg. findRelatedAnswers above only ever sees ci.answers —
    // sixteen rows against the ~900k the user has indexed — which is why this
    // listener used to answer "I'm not sure, I haven't really thought about it"
    // to questions the corpus answers outright. RecallService is the retrieval
    // pipeline the rest of the appliance already uses (boosted seed → semantic
    // fallback → entity resolution → one hop of query-relevant graph expansion),
    // so the evidence here is the same evidence the agent surfaces elsewhere.
    const evidence = this.composeEvidence(await this.findMemoryEvidence(serviceContext, question.text));

    const systemParts = [
      `You impersonate the user and infer a first-person answer to a question they have not answered yet.

Ground the answer in the EVIDENCE below, and score how well grounded it actually is. INFER — the evidence is a record of what this person did, not a list of what they believe, so the answer will almost never be written out anywhere in it. Reading the pattern is the job.

Read the question first and the evidence second. The retrieval that produced the EVIDENCE block matched on words and nearness, not on whether anything in it answers what was asked, so some of it is about the question's topic without bearing on the question, and some of it is other people talking about themselves. Deciding which is which is the first half of the job, and is what \`asked_for\`, \`support\` and \`first_person_evidence\` are for.

${INFERRED_ANSWER_PROMPT_RULES}`,
      // Evidence first, and the ONLY source section: it is the only material
      // drawn from the user's own records rather than from prose about them, so
      // it should be what the model reads while the instructions are still in
      // view.
      //
      // ═══ WHY THE DOSSIER IS GONE ═══
      //
      // `UserContextService.getUserContextForLLM` used to append a "User
      // Context" block here. It is removed, for two independent reasons:
      //
      //   1. It is UNCITABLE. Nothing in it carries a line number, a date or a
      //      speaker, so it can never satisfy `first_person_evidence` — and a
      //      block that cannot support an answer can only distort one. Measured:
      //      "Which hobby have you kept the longest, and for how many years?"
      //      came back "Woodworking — about fifteen years now." at 0.90, with
      //      the rationale "The User Context section explicitly states,
      //      'Woodworking — about fifteen years now.'" It does not; the string
      //      "woodwork" occurs twice in 325k communications, both times inbound,
      //      both times the idiom "out of the woodwork".
      //   2. On this appliance it is about the WRONG PERSON.
      //      `resolveUserEntity` falls back to `getNodes(userId, {entityType:
      //      'Person', limit: 1})` when `ci.users.entity_id` is unset, takes
      //      whichever contact comes back first, and writes it back. The owner's
      //      self-entity is a vCard-imported LinkedIn contact, so the dossier's
      //      family, preferences and dislikes describe a stranger. That is a
      //      graph-identity bug and is not fixed here — but nothing should be
      //      speaking in the owner's voice off the back of it in the meantime.
      evidence.block
        ? `EVIDENCE — retrieved from this person's own imported memory and NUMBERED so you can cite it. Each line carries its source label and, where the record has one, its date. Draw the answer OUT of these lines — do not require one of them to state it. Name the lines you used in your rationale, and put the numbers of the first-person ones in \`first_person_evidence\`.

${evidence.block}`
        : 'No memory evidence was retrieved for this question — there is nothing here to ground an answer in. Say so in the rationale, return "first_person_evidence": [], and score accordingly.',
      // Last, and framed as background rather than as source material. Measured
      // failure: handed its own prior answer to "Which languages are you
      // learning?", the model returned that sentence verbatim for "What
      // languages do you speak?" and scored it 0.9, with the rationale "The
      // answer is explicitly provided in the 'Related questions the user already
      // answered' section". Speaking a language and studying one are different
      // facts; the block was read as a lookup table.
      resolvedAnswers.length > 0
        ? `Answers this person gave to OTHER questions, in their own words. Background only — not evidence for this question. An answer to a different question is never this question's answer: do not restate one, and do not let one raise your confidence.\n\n${resolvedAnswers
            .map(
              (answer) => `Question: ${answer.question?.text ?? '(unspecified)'}\nAnswer: ${answer.answer}`,
            )
            .join('\n\n')}`
        : 'No related prior answers were found — rely on the evidence only.',
    ].filter((part): part is string => part != null);

    const ragThread = [
      {
        role: 'system',
        content: systemParts.join('\n\n'),
      },
      {
        role: 'user',
        content: `Question to answer as the user:\n${question.text}`,
      },
    ];

    const controller = new AbortController();
    // The call must be bounded and cancellable: unbounded, a hung or slow-loading model held its
    // job and the single-slot LLM_BACKGROUND_QUEUE behind it, and a request that cannot be
    // cancelled keeps its model slot (see `TodoScanService.SCAN_TIMEOUT_MS`), so retries queued
    // behind their own predecessors' orphaned generations.
    //
    // The bound is `llm.answerInferenceTimeoutMs` (270s), not the 60s the other planning-domain
    // calls use: the call is non-streaming, so the first byte is the finished answer, and a pool
    // placement on a slow CPU node was aborted at 60s and retried. It is also handed to the
    // backend as this call's first-response deadline, which would otherwise cut it at
    // `llm.firstResponseTimeoutMs`. Unlike the planning calls this one stays on PROMPT_MODEL.
    const timeoutMs = config.llm.answerInferenceTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let llmResponse;

    try {
      llmResponse = await this.ollamaService.chat(serviceContext, ragThread, {
        model: PROMPT_MODEL,
        // The schema — not the bare 'json' string — is what makes the confidence
        // and rationale a contract rather than a request. See
        // INFERRED_ANSWER_JSON_SCHEMA.
        format: INFERRED_ANSWER_JSON_SCHEMA,
        signal: controller.signal,
        firstResponseTimeoutMs: timeoutMs,
        maxOutputTokens: INFERENCE_MAX_OUTPUT_TOKENS,
        keepAlive: INFERENCE_KEEP_ALIVE,
      });
    } finally {
      clearTimeout(timer);
    }

    const rawContent = llmResponse.message.content ?? '';
    const inferred: InferredAnswer | null = parseInferredAnswer(rawContent);

    if (!inferred) {
      // No usable structured result. Deliberately NOT salvaged by treating the
      // raw text as the answer: without a score there is nothing to hold the
      // floor against, and a confidence invented here would be exactly the
      // fabrication this path exists to prevent. Keep the evidence — "nothing
      // came back" was previously impossible to diagnose from the logs alone.
      this.logger.warn('Answer inference returned no usable structured answer', {
        userId: ownerId,
        questionId: question.id,
        content: rawContent.slice(0, 500),
      });

      return { status: 'discarded', reason: 'unparseable' };
    }

    // A refusal is not an answer, whatever score came back with it. The floor
    // below would already catch it — parseInferredAnswer clamps a non-answer to
    // CONFIDENCE_NON_ANSWER — but the floor is owner-configurable and could be
    // set low enough to let one through, and "I do not have this information
    // recorded" written into ci.answers is indistinguishable at a glance from
    // the user having said it. Refuse the write itself, not just the score.
    // Same reasoning for the voice: parseInferredAnswer has already stripped the
    // narrator framing it can strip ("My record shows I …" → "I …"), so anything
    // still narrating here has the corpus woven into the claim itself — "The
    // user prefers mornings", "a strong interest, per my records". That is not
    // the user speaking, and it is published on their profile as if it were.
    if (isNonAnswer(inferred.answer) || isNarratedVoice(inferred.answer)) {
      this.logger.log('Inferred answer discarded — model returned a non-answer', {
        userId: ownerId,
        questionId: question.id,
        question: question.text,
        memoryEvidence: evidence.shownCount,
        firstPersonEvidence: evidence.ownCount,
        response: inferred.answer,
        rationale: inferred.rationale,
      });

      return { status: 'discarded', reason: 'non-answer', inferred };
    }

    // ═══ THE SPEAKER GATE ═══
    //
    // The answer is written in the first person and published on this person's
    // own profile, so it has to be supported by something THIS person said or
    // did. Just over half of the corpus is other people talking, and an inbound
    // message is evidence about a CONVERSATION, not a statement about the
    // account holder.
    //
    // Measured live, before this gate: 8 of 13 stored answers rested on inbound
    // citations. "Are you more of a cat person or a dog person?" → "I am
    // definitely a cat person, and I have cats." at 0.95, off three other
    // people's messages about THEIR cats; the owner's only outbound pet line is
    // "My dog needs to be put down today :(". "What do you remember most about
    // the home you grew up in?" returned somebody else's childhood verbatim.
    //
    // Deterministic, not advisory: the prompt asks which numbered lines carry
    // the claim, and `enforceFirstPersonEvidence` only counts a citation that
    // resolves to a line THIS side tagged as the owner's own. Citing nothing,
    // citing an inbound line, or citing a number that is not in the block are
    // all the same verdict. So `support` cannot come back 'stated' or 'implied'
    // on inbound-only evidence — it is rewritten to 'topical' and the gate below
    // discards it.
    const attribution = enforceFirstPersonEvidence(inferred, evidence.ownLineNumbers);

    if (!attribution.grounded) {
      this.logger.log('Inferred answer discarded — nothing this person said or did supports it', {
        userId: ownerId,
        questionId: question.id,
        question: question.text,
        memoryEvidence: evidence.shownCount,
        firstPersonEvidence: evidence.ownCount,
        citedLines: inferred.firstPersonEvidence ?? [],
        askedFor: inferred.askedFor,
        support: inferred.support,
        response: inferred.answer,
        rationale: inferred.rationale,
      });

      return { status: 'discarded', reason: 'unattributed', inferred: attribution.inferred };
    }

    // ═══ THE ABOUTNESS GATES ═══
    //
    // The speaker gate above settles who WROTE the evidence. These two settle
    // who the claim is ABOUT, and that is not the same question: most of what
    // anybody writes is about something other than themselves. Measured live,
    // both self-reported `stated` at 0.80 with a rationale arguing the point,
    // both resting on genuinely outbound lines:
    //
    //   "How tall are you?"            → "It'll be like a foot tall."
    //   "…cat person or a dog person?" → "It's like a mix between a dog and a cat."
    //
    // The first is the owner describing an object they were building; the second
    // is them relaying what some ANIMAL apparently is. Retrieval surfaced both BECAUSE
    // they carry the question's vocabulary, which is exactly what makes the
    // failure look like a match. `support` cannot catch it — the model called
    // both `stated` and defended it.
    //
    // The EVIDENCE side goes first because it is the stable one. Asked "How tall
    // are you?" twice, the model answered "It'll be like a foot tall." and then
    // "About a foot tall." — the same claim off the same single citation, and
    // only the first has a tell in the answer text. The line does not change
    // between runs.
    const citedTexts = attribution.citedOwn.map((line) => evidence.linesByNumber.get(line)?.text ?? '');
    const aboutness = enforceEvidenceIsAboutThePerson(inferred, citedTexts);

    if (!aboutness.aboutThePerson) {
      this.logger.log('Inferred answer discarded — every line it cites is about something else', {
        userId: ownerId,
        questionId: question.id,
        question: question.text,
        memoryEvidence: evidence.shownCount,
        firstPersonEvidence: evidence.ownCount,
        citedLines: attribution.citedOwn,
        citedText: citedTexts,
        askedFor: inferred.askedFor,
        support: inferred.support,
        response: inferred.answer,
        rationale: inferred.rationale,
      });

      return { status: 'discarded', reason: 'evidence-not-about-this-person', inferred: aboutness.inferred };
    }

    // And the ANSWER side: the sentence itself, where "it" is the subject and
    // nobody else is in the sentence. It catches the case the evidence gate
    // cannot — a claim assembled from several lines, only one of which is about
    // a thing — and it is the shape both live failures were published in.
    if (isAboutSomethingElse(inferred.answer)) {
      this.logger.log('Inferred answer discarded — the sentence is about something else', {
        userId: ownerId,
        questionId: question.id,
        question: question.text,
        memoryEvidence: evidence.shownCount,
        firstPersonEvidence: evidence.ownCount,
        citedLines: attribution.citedOwn,
        askedFor: inferred.askedFor,
        support: inferred.support,
        response: inferred.answer,
        rationale: inferred.rationale,
      });

      return { status: 'discarded', reason: 'answer-not-about-this-person', inferred };
    }

    // ═══ THE FORCED-CHOICE COMMITMENT GATE ═══
    //
    // A `multiple_choice` question that names its own two (or few) options is
    // not answered by a sentence that only orbits the topic. Measured live:
    // "Do you prefer small gatherings or large parties?" answered "It depends
    // on the parties I go to." at 0.75 — `support` unset, so nothing upstream
    // caught it, and the sentence is circular rather than uncertain: "the
    // parties I go to" is the question's own axis handed back, not new
    // information about which size this person prefers.
    //
    // A phrase-ban on hedges was tried and rejected before this gate existed —
    // "Do you prefer the beach or the mountains?" has a CORRECT promoted
    // answer, "I'm not sure, but I prefer the beach and nature areas.", that
    // hedges AND commits. The test this gate runs is narrower and survives
    // that case: does the answer name EITHER alternative the question itself
    // named, by word or unmistakable paraphrase? See
    // `extractForcedChoiceAlternatives` for how the alternatives are read out
    // of the question text, and why most open-domain `multiple_choice`
    // questions ("What time of day do you prefer to exercise?") are left
    // alone entirely rather than forced into a split that is not there.
    const forcedChoice = enforceForcedChoiceCommitment(inferred, question);

    if (!forcedChoice.committed) {
      this.logger.log('Inferred answer discarded — names neither alternative the question asked between', {
        userId: ownerId,
        questionId: question.id,
        question: question.text,
        alternatives: forcedChoice.alternatives,
        askedFor: inferred.askedFor,
        support: inferred.support,
        response: inferred.answer,
        rationale: inferred.rationale,
      });

      return { status: 'discarded', reason: 'forced-choice-not-committed', inferred: forcedChoice.inferred };
    }

    // ═══ THE YES/NO QUALIFIED-ANSWER GATE ═══
    //
    // `yes_no` has no alternatives to extract — its poles are always yes and
    // no — so the failure this gate exists for is narrower: an "it depends on
    // X" answer where X is the question's own subject rather than an actual
    // condition. "It depends on the price." for "Do you buy the extended
    // warranty when it is offered?" is a GOOD answer — price is a real
    // variable the question never named. "It depends on the parties I go to"
    // would be circular for exactly the same reason the forced-choice gate
    // above catches it on the `multiple_choice` version of that question. See
    // `enforceYesNoQualifierIsInformative` for how a genuine condition is told
    // apart from a restatement.
    const yesNoQualifier = enforceYesNoQualifierIsInformative(inferred, question);

    if (!yesNoQualifier.informative) {
      this.logger.log(
        'Inferred answer discarded — "it depends" restates the question rather than adding a condition',
        {
          userId: ownerId,
          questionId: question.id,
          question: question.text,
          askedFor: inferred.askedFor,
          support: inferred.support,
          response: inferred.answer,
          rationale: inferred.rationale,
        },
      );

      return {
        status: 'discarded',
        reason: 'yes-no-qualifier-not-informative',
        inferred: yesNoQualifier.inferred,
      };
    }

    // An answer to a NEARBY question is not an answer to this one, and it is the
    // most damaging thing this path can write: unlike a refusal it reads as a
    // fact, so nothing about it looks wrong on the profile. Measured live —
    // "Which health conditions run in your immediate family?" answered "There are
    // doctors in my family." at 0.90, off evidence that matched on 'family' and
    // 'immediate' and named no condition at all.
    //
    // A gate rather than a low score, for the same reason the refusal above is a
    // gate: `config.reflection.minAnswerConfidence` is owner-configurable and is
    // 0 on at least one real appliance, so the floor cannot be relied on to stop
    // anything. `support` is the model's own judgement, so this catches only what
    // the model itself recognised as a near miss — but it is the judgement it
    // makes BEFORE writing the answer (see INFERRED_ANSWER_JSON_SCHEMA's property
    // order), which is the one worth trusting.
    if (!answersTheQuestion(inferred.support)) {
      this.logger.log('Inferred answer discarded — evidence does not answer the question asked', {
        userId: ownerId,
        questionId: question.id,
        question: question.text,
        memoryEvidence: evidence.shownCount,
        firstPersonEvidence: evidence.ownCount,
        askedFor: inferred.askedFor,
        support: inferred.support,
        response: inferred.answer,
        rationale: inferred.rationale,
      });

      return { status: 'discarded', reason: 'off-question', inferred };
    }

    // The model's own score, capped by how much evidence the prompt actually
    // carried — a model handed nothing still claims certainty, and only this
    // side of the call knows how thin the context was.
    // `false` for the dossier because there no longer is one (see above), and
    // the FIRST-PERSON line count rather than the total: an answer about this
    // person is only as well grounded as the part of the block that is actually
    // about this person. Twenty lines of other people talking are worth the same
    // ceiling as none.
    const evidenceCeiling = estimateInferredAnswerConfidence(
      resolvedAnswers.length,
      false,
      evidence.ownCount,
    );
    const confidence = calibrateInferredConfidence(inferred.confidence, evidenceCeiling);

    // ═══ WHAT THE ANSWER IS MADE OF ═══
    //
    // `attribution.citedOwn` is already the checked citation set — the gate above
    // dropped every number that did not land on a line THIS side tagged as the
    // owner's own — so the numbers here are exactly the ones that were allowed to
    // carry the claim. Turning them back into rows costs one map lookup each, and
    // it is the whole difference between a badge that asserts and a badge the
    // owner can open.
    //
    // The citations are what the model NAMED, not everything retrieval returned.
    // Everything else it read is stored too, in `uncited` below — but in its own
    // array, because a single flat list of all twenty would bury the two lines
    // the answer actually rests on among eighteen it does not.
    const citedRefs = this.citationsFor(attribution.citedOwn, evidence);

    // ═══ AND WHAT IT READ AND DID NOT USE ═══
    //
    // The other eighteen lines. They used to exist only as the integer
    // `linesShown`, which is how the drawer came to say "20 records were put in
    // front of the model" above a list of two — the owner read that as eighteen
    // records being withheld, and there was no way to show them because nothing
    // kept them.
    //
    // Kept SEPARATE from `citations` rather than merged with a flag, because the
    // two are different claims and only one of them is what the answer rests on.
    // The distinction the drawer draws between them is the whole fix; a single
    // list with a boolean would put them one careless render away from reading
    // as equals.
    const uncitedRefs = this.uncitedFor(attribution.citedOwn, evidence);

    const answerEvidence: AnswerEvidence = {
      citations: citedRefs,
      uncited: uncitedRefs,
      linesShown: evidence.shownCount,
      linesOwn: evidence.ownCount,
      model: PROMPT_MODEL,
    };

    this.logger.log('Inferred answer to question', {
      userId: ownerId,
      questionId: question.id,
      question: question.text,
      relatedAnswers: resolvedAnswers.length,
      memoryEvidence: evidence.shownCount,
      firstPersonEvidence: evidence.ownCount,
      citedLines: attribution.citedOwn,
      citedObjects: citedRefs.map((citation) => `${citation.type}:${citation.id}`),
      uncitedStored: uncitedRefs.length,
      response: inferred.answer,
      askedFor: inferred.askedFor,
      support: inferred.support,
      modelConfidence: inferred.confidence,
      evidenceCeiling,
      confidence,
      confidenceLabel: confidenceLabel(confidence),
      rationale: inferred.rationale,
    });

    // The floor. Below it the appliance says nothing rather than writing a guess
    // into the user's own memory, where it would sit beside answers they typed
    // themselves and be indistinguishable from them at a glance. An unanswered
    // question costs a blank card; a fabricated one costs the credibility of
    // every other answer on the page. Configurable so an owner can demand more.
    const minConfidence = config.reflection.minAnswerConfidence;

    if (confidence < minConfidence) {
      this.logger.log('Inferred answer discarded — below the confidence floor', {
        userId: ownerId,
        questionId: question.id,
        confidence,
        minConfidence,
        rationale: inferred.rationale,
      });

      return { status: 'discarded', reason: 'below-floor', inferred, confidence };
    }

    const decision = await this.personalizationService.decideAction(ownerId, {
      kind: 'inferred_fact',
      confidence,
      hasUserInput: true,
    });

    if (decision === 'review') {
      this.logger.log('Inferred answer left unwritten for context prompt', {
        userId: ownerId,
        questionId: question.id,
      });

      return { status: 'discarded', reason: 'review', inferred, confidence };
    }

    if (decision === 'skip') {
      return { status: 'discarded', reason: 'skip', inferred, confidence };
    }

    return { status: 'ok', inferred, confidence, evidence: answerEvidence };
  }

  /**
   * Turn the model's checked line numbers into the rows they point at.
   *
   * Ordered by the model's own citation order rather than by line number: the
   * first number it named is the line it leant on hardest, and a drawer that
   * reorders them into retrieval order throws that away for no gain.
   *
   * A number with no line behind it is skipped rather than stored as a stub —
   * `enforceFirstPersonEvidence` has already established that every number here
   * is in `ownLineNumbers`, so a miss would mean the block and its index had
   * diverged, and half a citation is worse than none.
   */
  private citationsFor(citedLines: number[], evidence: ComposedEvidence): AnswerEvidenceCitation[] {
    const citations: AnswerEvidenceCitation[] = [];

    for (const line of citedLines) {
      const recalled = evidence.linesByNumber.get(line);

      if (!recalled) {
        continue;
      }

      citations.push(this.referenceFor(line, recalled, MAX_STORED_SNIPPET));

      if (citations.length >= MAX_STORED_CITATIONS) {
        break;
      }
    }

    return citations;
  }

  /**
   * Every line the model was shown and did NOT name.
   *
   * Block order, not relevance order: the numbering is what the model read them
   * in, and the owner scanning this group is retracing that read. Reordering it
   * would make "the model saw this fourth and skipped it" unrecoverable.
   *
   * Keyed off `citedOwn` — the numbers the model NAMED and the gate accepted —
   * rather than off the stored `citations` array, so this stays "what the model
   * passed over" and not "whatever did not fit in the citation cap". The two
   * only diverge past {@link MAX_STORED_CITATIONS}, where a named line would
   * otherwise reappear here labelled unused, which is the one thing this group
   * must never say.
   *
   * `voice` rides along untouched: an inbound line that was retrieved and
   * correctly left alone is the most informative row in the group.
   */
  private uncitedFor(citedLines: number[], evidence: ComposedEvidence): AnswerEvidenceCitation[] {
    const cited = new Set(citedLines);
    const uncited: AnswerEvidenceCitation[] = [];

    for (const [line, recalled] of [...evidence.linesByNumber.entries()].sort((a, b) => a[0] - b[0])) {
      if (cited.has(line)) {
        continue;
      }

      uncited.push(this.referenceFor(line, recalled, MAX_STORED_UNCITED_SNIPPET));

      if (uncited.length >= MAX_STORED_UNCITED) {
        break;
      }
    }

    return uncited;
  }

  /**
   * One recall line as the stored `{line, type, id, at, voice, snippet}` shape.
   *
   * Shared by both groups so a cited and an uncited row are structurally
   * identical on the wire — the frontend renders them through one reader, and
   * the ONLY difference between them is which array they arrived in.
   */
  private referenceFor(line: number, recalled: RecallLine, snippetLimit: number): AnswerEvidenceCitation {
    return {
      line,
      type: recalled.ref.type,
      id: recalled.ref.id,
      at: recalled.ref.at,
      voice: recalled.voice,
      snippet: recalled.text.slice(0, snippetLimit),
    };
  }

  /**
   * Write the accepted answer, or leave a hand-written one alone.
   */
  private async persistInferredAnswer(
    serviceContext: UserServiceContext,
    questionId: string,
    inferred: InferredAnswer,
    confidence: number,
    evidence: AnswerEvidence,
  ): Promise<void> {
    const ownerId = serviceContext.userId;
    const existingAnswer = await this.answerService.findByQuestionId(serviceContext, questionId);

    // A row this same path wrote before (answerSource: 'inferred') is safe to
    // refresh. Anything else — typed by the user, an about-you correction,
    // imported — is real content, and the only thing this listener knows about
    // it is that it did not write it. Overwriting on a benign timing race would
    // silently replace an answer the user actually gave. See AnswerProvenance on
    // the frontend, which keys the same "Inferred" vs "Manual" distinction off
    // this field.
    if (existingAnswer && existingAnswer.answerSource !== 'inferred') {
      this.logger.log('Inferred answer discarded — existing answer is not machine-inferred', {
        userId: ownerId,
        questionId,
        answerId: existingAnswer.id,
        answerSource: existingAnswer.answerSource,
      });

      return;
    }

    if (existingAnswer) {
      await this.answerService.update(serviceContext, existingAnswer.id, {
        text: inferred.answer,
        answerMethod: 'inferred',
        answerSource: 'inferred',
        answerConfidence: confidence,
        answerRationale: inferred.rationale ?? null,
        answerEvidence: evidence,
      });
    } else {
      await this.answerService.create(serviceContext, {
        text: inferred.answer,
        question: { id: questionId },
        answerMethod: 'inferred',
        answerSource: 'inferred',
        answerConfidence: confidence,
        answerRationale: inferred.rationale ?? null,
        answerEvidence: evidence,
      });
    }
  }

  /**
   * Retrieve the question's supporting evidence from the user's own indexed
   * memory, as a prompt-ready block plus the number of lines in it.
   *
   * RecallService already fails soft (it returns an empty block rather than
   * throwing), so this wrapper exists for the case it cannot cover — the call
   * itself blowing up — and to keep "no evidence" a normal, loggable outcome
   * rather than a lost inference. An answer grounded only in the dossier is
   * worse than one grounded in records, but it is still better than none.
   *
   * ═══ WHY 'grounded', AND WHY NOT 'answer' ═══
   *
   * The default recall strategy is tuned for an agent looking something up, where
   * a near-miss costs a wasted line. Here a near-miss costs a FABRICATION, or —
   * measured on the reference corpus — a refusal in spite of good evidence,
   * because the good evidence arrived buried in lexical noise. What the default
   * seed returned for these questions: song titles containing "City" for "What
   * city do you live in?", RC monster-truck shopping for "What sports do you
   * follow?", a 3D-digital-human article for "What languages do you speak?".
   * `strategy: 'grounded'` is the precision-first path built for exactly this.
   *
   * 'answer' is excluded because this listener WRITES ci.answers, and every row
   * in it was written by this listener. Retrieving them as "evidence retrieved
   * from the user's own imported memory" hands the model its own previous output
   * relabelled as a record of the user's life — and 20 of the 23 rows on the
   * reference corpus say "I do not have this information recorded", which
   * retrieved at cosine 0.891 as the third-best evidence for the very question
   * that produced it. Prior answers still reach the prompt, through
   * {@link findRelatedAnswers}, in the section that says what they are.
   */
  private async findMemoryEvidence(context: UserServiceContext, questionText: string): Promise<RecallLine[]> {
    try {
      const recall = await this.recallService.recall(
        context,
        {
          query: questionText,
          maxResults: MEMORY_EVIDENCE_SEEDS,
        },
        { strategy: 'grounded', excludeTypes: ['answer'] },
      );

      if (recall.resultCount > 0) {
        return recall.lines ?? [];
      }
    } catch (err) {
      this.logger.warn('Answer inference memory recall failed', {
        userId: context.userId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return [];
  }

  /**
   * Turn tagged recall lines into the EVIDENCE section, split by WHO SPOKE.
   *
   * Two headed sections rather than one list, and numbering that runs across
   * both, because the number is the only handle the model has on a line and the
   * heading is the only thing that tells it what the line is worth. The split is
   * what makes `first_person_evidence` answerable and
   * {@link enforceFirstPersonEvidence} checkable: `ownLineNumbers` is the set a
   * citation has to land in.
   *
   * `[inbound, …]` reached the model before this and was ignored — the labels
   * were sitting in the rationales of every one of the eight misattributed
   * answers. Jargon in a corner of a line is not a speaker attribution; a
   * heading the lines are filed under is.
   */
  private composeEvidence(lines: RecallLine[]): ComposedEvidence {
    const own = lines.filter((line) => line.voice === 'own');
    const other = lines.filter((line) => line.voice === 'other').slice(0, OTHER_VOICE_EVIDENCE_LIMIT);

    if (own.length === 0 && other.length === 0) {
      return {
        block: '',
        ownLineNumbers: new Set(),
        linesByNumber: new Map(),
        ownCount: 0,
        shownCount: 0,
      };
    }

    const ownLineNumbers = new Set<number>();
    // The number the model cites is minted in the two loops below and nowhere
    // else, so the index has to be built here, in lockstep with the block. Any
    // later attempt to reconstruct it (re-walking `own` then `other`) would be a
    // second implementation of the same numbering, free to drift from this one.
    const linesByNumber = new Map<number, RecallLine>();
    const sections: string[] = [];
    let number = 0;

    if (own.length > 0) {
      const numbered = own.map((line) => {
        number += 1;
        ownLineNumbers.add(number);
        linesByNumber.set(number, line);

        return `${number}. ${line.text}`;
      });

      sections.push(
        `MY OWN RECORDS — this person wrote it or did it: messages they SENT, places they went, pages they opened, things they bought, events they attended. These are the ONLY lines that can support a first-person answer, and \`first_person_evidence\` must name at least one of them.\n${numbered.join('\n')}`,
      );
    } else {
      sections.push(
        'MY OWN RECORDS — nothing this person wrote or did came back for this question. There is therefore no line that can support a first-person claim: return "first_person_evidence": [] and "support": "topical".',
      );
    }

    if (other.length > 0) {
      const numbered = other.map((line) => {
        number += 1;
        linesByNumber.set(number, line);

        return `${number}. ${line.text}`;
      });

      sections.push(
        `WHAT OTHER PEOPLE SAID TO ME — somebody else's words, arriving in this person's archive. Read them: they show what this person was replying to, and they can CORROBORATE a claim. They can never ESTABLISH one, and they are never this person speaking — a line here saying "I have a cat" means SOMEONE ELSE has a cat. Putting one of these numbers in \`first_person_evidence\` counts as citing nothing.\n${numbered.join('\n')}`,
      );
    }

    return {
      block: sections.join('\n\n'),
      ownLineNumbers,
      linesByNumber,
      ownCount: own.length,
      shownCount: own.length + other.length,
    };
  }

  /**
   * Prior answers worth putting in front of the model — the user's OWN, only.
   *
   * ═══ WHY MACHINE-INFERRED ROWS ARE EXCLUDED ═══
   *
   * Every row this listener writes carries `answerSource: 'inferred'`, and on
   * the reference corpus that is 21 rows out of 21. Handing them back as
   * "questions the user already answered" presents this path's own guesses to
   * itself as though the person had said them, and the model — correctly, given
   * that framing — treats a sentence sitting under a neighbouring question as
   * the best evidence in the prompt.
   *
   * Measured: asked "What languages do you speak?", the model returned its own
   * earlier answer to "Which languages are you learning, if any?" verbatim and
   * scored it 0.9, rationale "The answer is explicitly provided in the 'Related
   * questions the user already answered' section". One retrieval, three
   * questions, two fabrications — speaking a language and studying one are not
   * the same fact, and "what skill are you working on this year" is not either.
   *
   * This is the same decision {@link findMemoryEvidence} already makes when it
   * passes `excludeTypes: ['answer']`, for the same reason, one prompt section
   * over. Answers the user typed (`answerSource` anything else — 'user_input',
   * an about-you correction, an import) are real statements by the person and
   * stay: those are the rows this block was always meant to carry.
   */
  private async findRelatedAnswers(
    context: UserServiceContext,
    questionText: string,
    excludeQuestionId: string,
  ): Promise<Answer[]> {
    const seen = new Set<string>();
    const resolved: Answer[] = [];
    const isMachineInferred = (answer: Answer) => answer.answerSource === 'inferred';

    try {
      const hits = await this.searchService.search(context, {
        query: questionText,
        mode: 'boosted',
        maxResults: RELATED_ANSWER_LIMIT,
        includeTypes: ['answer'],
      });

      if (hits.length > 0) {
        const byId = await this.answerService.findByIds(
          context as ServiceContext,
          hits.map((hit) => hit.id),
        );

        for (const answer of byId) {
          if (!answer || answer.question?.id === excludeQuestionId || seen.has(answer.id)) {
            continue;
          }

          // "I do not have this information recorded." is not a related answer,
          // it is the absence of one. Rows written before isNonAnswer gated the
          // write are still in ci.answers, and the prompt block presents them as
          // "questions the user already answered" — so the model reads a wall of
          // its own refusals as evidence that refusing is what this user does.
          if (isNonAnswer(answer.answer) || isMachineInferred(answer)) {
            continue;
          }

          seen.add(answer.id);
          resolved.push(answer);
        }
      }
    } catch (err) {
      this.logger.warn('Answer inference semantic search failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    if (resolved.length >= 3) {
      return resolved.slice(0, RELATED_ANSWER_LIMIT);
    }

    const recent = await this.answerService.findAll(context);
    const sorted = [...recent]
      .filter(
        (answer) =>
          answer.question?.id !== excludeQuestionId &&
          !seen.has(answer.id) &&
          !isNonAnswer(answer.answer) &&
          !isMachineInferred(answer),
      )
      .sort((a, b) => new Date(b.answeredAt).getTime() - new Date(a.answeredAt).getTime())
      .slice(0, RECENT_ANSWER_FALLBACK);

    return [...resolved, ...sorted].slice(0, RELATED_ANSWER_LIMIT);
  }
}
