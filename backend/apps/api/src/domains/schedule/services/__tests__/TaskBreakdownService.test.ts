import { BadRequestException } from '@nestjs/common';

import type { RequestContext, UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import type { RecallService } from '@ci/domains/agent';
import type { OllamaService } from '@ci/domains/llm';
import type { UserContextService } from '@ci/domains/memory';
import { flexWindow, type PlacementService } from '@ci/domains/personalization';

import type { CreateCandidateDto } from '../../types';
import type { CandidateService } from '../CandidateService';
import { TaskBreakdownService } from '../TaskBreakdownService';

const CONTEXT = { userId: 'user-1' } as UserServiceContext & RequestContext;
const AT = new Date('2026-08-04T09:00:00.000Z');

/**
 * A generation that never comes back — an Ollama host that accepted the
 * connection and then went quiet, or a model still loading. Stands in for the
 * real service, which races the call against the caller's signal because the
 * ollama client cannot cancel a non-streaming request.
 */
const HANGS = Symbol('never answers');

type Reply = string | Error | typeof HANGS;

function makeService(content: Reply | Reply[]) {
  const upserted: CreateCandidateDto[][] = [];
  const replies = Array.isArray(content) ? [...content] : null;
  // Typed via <return, args> rather than named parameters so the `format`
  // argument is inspectable in the assertions below without tripping
  // no-unused-vars on placeholders.
  const chat = jest.fn<
    Promise<{ message: { role: string; content: string } }>,
    [unknown, unknown, { format?: Record<string, unknown>; signal?: AbortSignal }]
  >((_context, _messages, { signal }) => {
    const reply = replies ? (replies.shift() ?? '') : (content as Reply);

    if (reply === HANGS) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }

    // Anything that is not content is a rejection. Tested on the shape rather
    // than `instanceof Error` because jest runs the suite in its own realm, and
    // a host-realm DOMException — exactly what an abort rejects with — fails
    // that check while still being a perfectly ordinary rejection.
    if (typeof reply !== 'string') {
      return Promise.reject(reply);
    }

    return Promise.resolve({ message: { role: 'assistant', content: reply } });
  });

  const candidateService = {
    upsert: (_ctx: unknown, proposals: CreateCandidateDto[]) => {
      upserted.push(proposals);

      return Promise.resolve(proposals.map((p, i) => ({ id: `cand-${i}`, ...p })));
    },
  } as unknown as CandidateService;

  const ollamaService = { chat } as unknown as OllamaService;

  const logger = { setContext() {}, log() {}, warn() {}, debug() {}, error() {} } as unknown as LoggerService;

  const userContextService = {
    getUserContextForLLM: async () => null,
    formatContextForSystemPrompt: () => '',
  } as unknown as UserContextService;

  const recallService = {
    recall: async () => ({ block: '', resultCount: 0 }),
  } as unknown as RecallService;

  return {
    service: new TaskBreakdownService(
      candidateService,
      ollamaService,
      userContextService,
      recallService,
      {
        timezoneFor: async () => 'UTC',
        flexWindow,
      } as unknown as PlacementService,
      logger,
    ),
    upserted,
    chat,
  };
}

describe('TaskBreakdownService.parseTasks', () => {
  it('reads a clean JSON response', () => {
    const tasks = TaskBreakdownService.parseTasks(
      '{"tasks":[{"title":"Book the dentist","detail":"overdue since spring","duration_minutes":15,"l0_class":"ERRAND"}]}',
    );

    expect(tasks).toEqual([
      {
        title: 'Book the dentist',
        detail: 'overdue since spring',
        duration_minutes: 15,
        l0_class: 'ERRAND',
      },
    ]);
  });

  it('survives a markdown fence and leading prose', () => {
    const tasks = TaskBreakdownService.parseTasks(
      'Sure! Here you go:\n```json\n{"tasks":[{"title":"Call Mum"}]}\n```',
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Call Mum');
  });

  it('returns nothing rather than throwing on unparseable output', () => {
    expect(TaskBreakdownService.parseTasks('I could not do that')).toEqual([]);
    expect(TaskBreakdownService.parseTasks('')).toEqual([]);
    expect(TaskBreakdownService.parseTasks('{"tasks":"not an array"}')).toEqual([]);
  });

  it('drops a detail that only restates the title', () => {
    const [task] = TaskBreakdownService.parseTasks('{"tasks":[{"title":"Call Mum","detail":"call mum"}]}');

    expect(task.detail).toBeUndefined();
  });

  it('drops a duration outside the plausible range', () => {
    const tasks = TaskBreakdownService.parseTasks(
      '{"tasks":[{"title":"A","duration_minutes":1},{"title":"B","duration_minutes":10000},{"title":"C","duration_minutes":45}]}',
    );

    expect(tasks[0].duration_minutes).toBeUndefined();
    expect(tasks[1].duration_minutes).toBeUndefined();
    expect(tasks[2].duration_minutes).toBe(45);
  });

  it('drops an out-of-vocabulary class instead of passing it through', () => {
    // It would render as "unsorted" anyway, and this keeps an invented label out
    // of ci.events.category when the card is accepted.
    const tasks = TaskBreakdownService.parseTasks(
      '{"tasks":[{"title":"A","l0_class":"CHORES"},{"title":"B","l0_class":"UNKNOWN"},{"title":"C","l0_class":"work"}]}',
    );

    expect(tasks[0].l0_class).toBeUndefined();
    expect(tasks[1].l0_class).toBeUndefined();
    expect(tasks[2].l0_class).toBe('WORK');
  });

  it('caps the batch so a dump cannot flood the slate', () => {
    const many = Array.from({ length: 30 }, (_, i) => `{"title":"Task ${i}"}`).join(',');

    expect(TaskBreakdownService.parseTasks(`{"tasks":[${many}]}`)).toHaveLength(12);
  });

  it('skips a task with neither a title nor a detail, and trims a trailing period', () => {
    const tasks = TaskBreakdownService.parseTasks('{"tasks":[{"title":"   "},{"title":"Prep the deck."}]}');

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Prep the deck');
  });

  it('keeps the good tasks when one sibling is malformed', () => {
    // The whole-array parse used to be all-or-nothing, so a single bad task
    // discarded every good one beside it. Observed live: a generation whose
    // first task had an empty title and whose second was fine returned nothing.
    const tasks = TaskBreakdownService.parseTasks(
      '{"tasks":[{"nope":1},{"title":"Prep the deck"},{"title":42},{"title":"Call Mum"}]}',
    );

    expect(tasks.map((t) => t.title)).toEqual(['Prep the deck', 'Call Mum']);
  });

  it('promotes the detail when the model leaves the title empty', () => {
    // Measured against gemma3:1b: even schema-constrained it emits
    // `"title": ""` and files the task under `detail`. It identified the task
    // and only put it in the wrong field, so the row is salvageable.
    const tasks = TaskBreakdownService.parseTasks(
      '{"tasks":[{"title":"","detail":"Pick up groceries.","duration_minutes":20}]}',
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Pick up groceries');
    expect(tasks[0].duration_minutes).toBe(20);
  });
});

describe('TaskBreakdownService.breakDown', () => {
  it('turns each extracted task into a candidate the user owns', async () => {
    const { service, upserted } = makeService(
      '{"tasks":[{"title":"Book the dentist","detail":"overdue","l0_class":"ERRAND"},{"title":"Prep the deck"}]}',
    );

    const written = await service.breakDown(CONTEXT, 'dentist, and prep thursday deck', AT);

    expect(written).toHaveLength(2);

    const [proposals] = upserted;
    expect(proposals.map((p) => p.title)).toEqual(['Book the dentist', 'Prep the deck']);
    // The because is the user's own words — nothing reaches the slate without one.
    expect(proposals[0].rationale).toBe('You wrote: overdue');
    expect(proposals[1].rationale).toBe('You wrote this down.');
    expect(proposals[0].l0_class).toBe('ERRAND');
    expect(proposals[0].window_start).toEqual(flexWindow('UTC', AT).windowStart);
  });

  it('is idempotent for one dump and distinct across sittings', async () => {
    const json = '{"tasks":[{"title":"Call Mum"}]}';
    const { service, upserted } = makeService(json);

    await service.breakDown(CONTEXT, 'call mum', AT);
    await service.breakDown(CONTEXT, 'call mum', AT);
    await service.breakDown(CONTEXT, 'call mum', new Date(AT.getTime() + 60_000));

    expect(upserted[0][0].dedupe_key).toBe(upserted[1][0].dedupe_key);
    expect(upserted[2][0].dedupe_key).not.toBe(upserted[0][0].dedupe_key);
  });

  it('stays out of the adapter namespace so the sync sweep never retires it', async () => {
    // SuggestionSyncService retires stale `adapter/` rows whose source action was
    // dismissed. A hand-written task has no upstream source to go stale.
    const { service, upserted } = makeService('{"tasks":[{"title":"Call Mum"}]}');

    await service.breakDown(CONTEXT, 'call mum', AT);

    expect(upserted[0][0].generator).toBe('braindump/llm');
    expect(upserted[0][0].generator?.startsWith('adapter/')).toBe(false);
  });

  it('rejects empty input and an oversized paste', async () => {
    const { service } = makeService('{"tasks":[]}');

    await expect(service.breakDown(CONTEXT, '   ', AT)).rejects.toThrow(BadRequestException);
    await expect(service.breakDown(CONTEXT, 'x'.repeat(4001), AT)).rejects.toThrow(BadRequestException);
  });

  it('writes nothing when the model returns nothing usable', async () => {
    const { service, upserted } = makeService('sorry, I cannot help with that');

    await expect(service.breakDown(CONTEXT, 'something', AT)).resolves.toEqual([]);
    expect(upserted).toHaveLength(0);
  });

  it('re-samples once when the first generation yields nothing', async () => {
    // A 1B model returns an unusable shape often enough that one bad roll must
    // not cost the user their note. Second sample wins.
    const { service, upserted, chat } = makeService([
      '{"tasks":[{"title":""}]}',
      '{"tasks":[{"title":"Make lunch"}]}',
    ]);

    const written = await service.breakDown(CONTEXT, 'I want to make lunch', AT);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(written).toHaveLength(1);
    expect(upserted[0][0].title).toBe('Make lunch');
  });

  it('does not re-sample when the first generation is usable', async () => {
    const { service, chat } = makeService('{"tasks":[{"title":"Make lunch"}]}');

    await service.breakDown(CONTEXT, 'I want to make lunch', AT);

    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('constrains generation with a JSON schema, not the bare json flag', async () => {
    // The bare flag only guarantees the output parses; the model stays free to
    // invent key names, which is exactly how "nothing came back" happened.
    const { service, chat } = makeService('{"tasks":[{"title":"Make lunch"}]}');

    await service.breakDown(CONTEXT, 'I want to make lunch', AT);

    const { format } = chat.mock.calls[0][2];
    expect(typeof format).toBe('object');
    expect(format?.required).toEqual(['tasks']);
  });
});

/**
 * The likeliest production failure for a local 1B model is not a bad answer, it
 * is no answer: the host is down, the model was never pulled, or it is still
 * loading. Every one of those has to read the same as an unparseable generation
 * — "nothing came back" — because the alternative is a 500, or a spinner that
 * never ends, on a note the user has just typed and cannot get back.
 */
describe('TaskBreakdownService.breakDown when the model does not answer', () => {
  it('degrades to nothing when the model call rejects', async () => {
    // What an unpulled model actually looks like: OllamaService validates the
    // model against `list()` first and throws before a token is generated.
    const rejected = () => new Error('Invalid model specified: gemma3:1b');
    const { service, upserted } = makeService([rejected(), rejected()]);

    await expect(service.breakDown(CONTEXT, 'call mum', AT)).resolves.toEqual([]);
    expect(upserted).toHaveLength(0);
  });

  it('degrades to nothing when the call is aborted by the deadline', async () => {
    // The rejection an AbortSignal.timeout race produces once the budget is up.
    const timedOut = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { service, upserted } = makeService([timedOut(), timedOut()]);

    await expect(service.breakDown(CONTEXT, 'call mum', AT)).resolves.toEqual([]);
    expect(upserted).toHaveLength(0);
  });

  it('gives up on a model that never answers rather than hanging the request', async () => {
    // A short budget stands in for the real one so the test does not sit out
    // fifteen seconds; the deadline itself is genuine, and so is the abort.
    const { service, upserted, chat } = makeService([HANGS, HANGS]);
    const started = Date.now();

    await expect(service.breakDown(CONTEXT, 'call mum', AT, 20)).resolves.toEqual([]);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(upserted).toHaveLength(0);
    // The budget is spent, so the re-sample is skipped instead of doubling what
    // the user waits.
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('still re-samples when the first call fails but the budget survives it', async () => {
    // A refused connection to a host that comes back is not worth losing the
    // note over — the retry covers a transport blip exactly as it covers a
    // useless generation.
    const { service, upserted, chat } = makeService([
      new Error('connect ECONNREFUSED 127.0.0.1:11434'),
      '{"tasks":[{"title":"Call Mum"}]}',
    ]);

    const written = await service.breakDown(CONTEXT, 'call mum', AT);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(written).toHaveLength(1);
    expect(upserted[0][0].title).toBe('Call Mum');
  });

  it('bounds the call with one deadline shared by both samples', async () => {
    const { service, chat } = makeService(['{"tasks":[{"title":""}]}', '{"tasks":[{"title":"Make lunch"}]}']);

    await service.breakDown(CONTEXT, 'I want to make lunch', AT);

    const [first, second] = chat.mock.calls.map((call) => call[2].signal);
    expect(first).toBeInstanceOf(AbortSignal);
    expect(first?.aborted).toBe(false);
    // One deadline, not one each: a retry must not buy a fresh budget.
    expect(second).toBe(first);
  });
});
