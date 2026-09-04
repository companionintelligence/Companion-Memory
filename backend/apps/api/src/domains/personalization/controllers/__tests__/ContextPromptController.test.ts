import { BadRequestException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';
import { ValidationPipe } from '@ci/common/pipes';
import type { EventService } from '@ci/domains/events';

import type { ContextPromptService } from '../../services/ContextPromptService';
import { ContextPromptController, contextPromptRespondSchema } from '../ContextPromptController';

/**
 * `enqueueGenerate` sent `SmartRotationWorkEvent` for `context_prompt` from
 * three interactive endpoints without a `priority`, so it defaulted to
 * `DEFAULT_JOB_PRIORITY` (0) — below the priority (5)
 * `SmartRotationService.workTypePriority('context_prompt')` assigns the same
 * work type on its cron path, on the SAME shared `smart-rotation` queue. A
 * human waiting on `GET /pending` could therefore sink behind unattended
 * cron-driven rotation work already queued for other users.
 */
const USER = 'user-1';
const ctx = { userId: USER } as RequestContext;

function makeController(opts: { pending?: unknown; respondResult?: unknown; skipResult?: unknown } = {}) {
  const send = jest.fn(async () => ['job-1']);
  const eventService = { send } as unknown as EventService;

  const contextPromptService = {
    getPending: jest.fn(async () => opts.pending ?? null),
    respond: jest.fn(async () => opts.respondResult ?? { id: 'prompt-1' }),
    skip: jest.fn(async () => opts.skipResult ?? { id: 'prompt-1' }),
  } as unknown as ContextPromptService;

  const controller = new ContextPromptController(contextPromptService, eventService);

  return { controller, send, contextPromptService };
}

/** The event, queue and options the interactive enqueue must have sent. */
function handoff(send: jest.Mock) {
  const [event, payload, options] = send.mock.calls[0] as [
    string,
    Record<string, unknown>,
    { queue?: string; singletonKey?: string; priority?: number } | undefined,
  ];

  return { event, payload, options };
}

describe('ContextPromptController interactive enqueue priority', () => {
  it('GET /pending enqueues context_prompt work at priority 5, not the DEFAULT_JOB_PRIORITY (0) it used to fall back to', async () => {
    const { controller, send } = makeController({ pending: null });

    await controller.getPending(ctx);

    expect(send).toHaveBeenCalledTimes(1);
    const { payload, options } = handoff(send);
    expect(payload).toEqual({ userId: USER, workType: 'context_prompt' });
    expect(options?.queue).toBe('smart-rotation');
    expect(options?.singletonKey).toBe(`smart-rotation:${USER}:context_prompt`);
    expect(options?.priority).toBe(5);
  });

  it('does not enqueue generate work when a prompt is already pending', async () => {
    const { controller, send } = makeController({ pending: { id: 'existing' } });

    await controller.getPending(ctx);

    expect(send).not.toHaveBeenCalled();
  });

  it('POST /:id/respond enqueues the next context_prompt at priority 5', async () => {
    const { controller, send } = makeController();

    await controller.respond(ctx, 'prompt-1', { response: 'ok' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(handoff(send).options?.priority).toBe(5);
  });

  it('POST /:id/skip enqueues the next context_prompt at priority 5', async () => {
    const { controller, send } = makeController();

    await controller.skip(ctx, 'prompt-1');

    expect(send).toHaveBeenCalledTimes(1);
    expect(handoff(send).options?.priority).toBe(5);
  });

  it('sends context_prompt at the same priority SmartRotationService assigns its own cron path, so an interactive request cannot rank below cron-enqueued work of the same type', async () => {
    // SmartRotationService.workTypePriority('context_prompt') returns 5 — this
    // pins the two call sites to the same number without importing the
    // private cron method.
    const CRON_CONTEXT_PROMPT_PRIORITY = 5;
    const { controller, send } = makeController();

    await controller.respond(ctx, 'prompt-1', { response: 'ok' });

    expect(handoff(send).options?.priority).toBe(CRON_CONTEXT_PROMPT_PRIORITY);
  });
});

/**
 * `respond` took a bare `@Body() body: { response?: unknown }`, so a JSON string
 * or array body reached `body.response` as `undefined` and silently answered the
 * prompt with `null`. The envelope is now validated even though the response
 * payload itself stays free-form.
 */
describe('ContextPromptController respond body validation', () => {
  const pipe = new ValidationPipe(contextPromptRespondSchema);

  it.each([
    ['a bare string', '"yes"'],
    ['an array', ['yes']],
    ['null', null],
  ])('rejects %s with 400', (_label, body) => {
    expect(() => pipe.transform(body)).toThrow(BadRequestException);
  });

  it('accepts an object envelope with any response payload, including an absent one', () => {
    expect(pipe.transform({ response: { choice: 'a', note: 'why' } })).toEqual({
      response: { choice: 'a', note: 'why' },
    });
    expect(pipe.transform({})).toEqual({});
  });

  it('still records a valid response', async () => {
    const { controller, contextPromptService } = makeController();

    await controller.respond(ctx, 'prompt-1', pipe.transform({ response: 'ok' }) as { response?: unknown });

    expect(contextPromptService.respond).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      'prompt-1',
      'ok',
    );
  });
});
