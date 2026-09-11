import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type UserServiceContext } from '@ci/common/context';
import { EventListenerRegistry } from '@ci/domains/events';
// FilePreviewService through the files PUBLIC barrel — `no-cross-domain-internals`
// allows only index.ts/events.ts across a domain boundary. (The listener import
// below predates the rule and sits in the known-violations baseline.)
import { FilePreviewService, FileUploadedEvent, PreviewGeneratedEvent } from '@ci/domains/files';

import { FilePreviewGenerationListener } from '../../../files/listeners/FilePreviewGenerationListener';
import { FileService } from '../../../files/services/FileService';
import {
  BROWSER_ACTIVITY_INSIGHT_QUEUE,
  BROWSER_ACTIVITY_INSIGHT_QUEUE_OPTIONS,
  IMAGE_DESCRIPTION_QUEUE,
  IMAGE_DESCRIPTION_QUEUE_OPTIONS,
  INTERACTIVE_CHAT_YIELD_GATE,
  OLLAMA_BACKGROUND_LANE,
  THING_VISION_QUEUE,
  THING_VISION_QUEUE_OPTIONS,
} from '../../constants';
import { BrowserActivityInsightListener } from '../BrowserActivityInsightListener';
import { ImageDescriptionBackfillListener } from '../ImageDescriptionBackfillListener';
import { ImageDescriptionListener } from '../ImageDescriptionListener';
import { ThingVisionListener } from '../ThingVisionListener';

/**
 * `policy: 'short'` is not a per-send opt-in: pg-boss makes it a QUEUE
 * property, and its unique index folds every job on the queue together under
 * `COALESCE(singleton_key, '')`. A queue may therefore declare it only if
 * EVERY producer of every event routed there carries a key — otherwise the
 * keyless sends all collapse onto one row and `ON CONFLICT DO NOTHING`
 * discards the rest with no error and no dead letter.
 *
 * These queues sit on opposite sides of that rule, which is why the tests
 * below drive the REAL producers rather than asserting a literal:
 *  - `image-description` consumes `preview.generated`, and both of its
 *    producers key on the preview id, so `short` is safe AND enforcing.
 *  - `thing-vision` consumes `file.uploaded`, whose only producer
 *    (`FileService.uploadWithDedupInfo`) sends keyless — and cannot grow a key,
 *    since that event fans out to five queues under one shared options object.
 *    So it must NOT declare `short`.
 */
// `@OnEvent` registers its queue options at class-DECLARATION time (module
// evaluation), not on instantiation — importing these classes is what already
// ran it against the shared EventListenerRegistry.
void ImageDescriptionListener;
void ThingVisionListener;
void BrowserActivityInsightListener;

describe('image-description / thing-vision queue declarations', () => {
  it('declares "short" policy and a 1-slot local ceiling on image-description, agreed by both registrants', () => {
    expect(EventListenerRegistry.getQueueOptions(IMAGE_DESCRIPTION_QUEUE)).toEqual(
      IMAGE_DESCRIPTION_QUEUE_OPTIONS,
    );
    expect(IMAGE_DESCRIPTION_QUEUE_OPTIONS.policy).toBe('short');
    expect(IMAGE_DESCRIPTION_QUEUE_OPTIONS.localConcurrency).toBe(1);
  });

  it('stands aside for an interactive chat turn — the gate InteractiveChatYieldGate registers by that name', () => {
    // Dispatching the next description the instant the last one finished is
    // what kept the GPU busy enough that Ollama could never swap the chat
    // model in (two turns in a row ended in the empty-answer fallback).
    expect(IMAGE_DESCRIPTION_QUEUE_OPTIONS.yieldsTo).toBe(INTERACTIVE_CHAT_YIELD_GATE);
    expect(EventListenerRegistry.getQueueOptions(IMAGE_DESCRIPTION_QUEUE)?.yieldsTo).toBe(
      INTERACTIVE_CHAT_YIELD_GATE,
    );
  });

  // Every Ollama-bound background queue shares the one single-slot runner
  // with chat, so every one of them stands aside for the same gate.
  it.each([
    ['thing-vision', THING_VISION_QUEUE, THING_VISION_QUEUE_OPTIONS],
    ['browser-activity-insight', BROWSER_ACTIVITY_INSIGHT_QUEUE, BROWSER_ACTIVITY_INSIGHT_QUEUE_OPTIONS],
  ])('%s stands aside for the interactive-chat gate too', (_label, queue, options) => {
    expect(options.yieldsTo).toBe(INTERACTIVE_CHAT_YIELD_GATE);
    expect(EventListenerRegistry.getQueueOptions(queue)?.yieldsTo).toBe(INTERACTIVE_CHAT_YIELD_GATE);
  });

  // And they share ONE slot between them: four single-slot queues would
  // otherwise put four generations in front of the runner at once.
  it.each([
    ['image-description', IMAGE_DESCRIPTION_QUEUE, IMAGE_DESCRIPTION_QUEUE_OPTIONS],
    ['thing-vision', THING_VISION_QUEUE, THING_VISION_QUEUE_OPTIONS],
    ['browser-activity-insight', BROWSER_ACTIVITY_INSIGHT_QUEUE, BROWSER_ACTIVITY_INSIGHT_QUEUE_OPTIONS],
  ])('%s draws from the shared ollama-background lane', (_label, queue, options) => {
    expect(options.lane).toBe(OLLAMA_BACKGROUND_LANE);
    expect(EventListenerRegistry.getQueueOptions(queue)?.lane).toBe(OLLAMA_BACKGROUND_LANE);
  });

  it('keeps the 1-slot local ceiling on thing-vision but declares NO policy, because its producer sends keyless', () => {
    expect(EventListenerRegistry.getQueueOptions(THING_VISION_QUEUE)).toEqual(THING_VISION_QUEUE_OPTIONS);
    expect(THING_VISION_QUEUE_OPTIONS.policy).toBeUndefined();
    expect(THING_VISION_QUEUE_OPTIONS.localConcurrency).toBe(1);
  });

  it('routes preview.generated to image-description alone, which is what lets that queue declare "short"', () => {
    expect(Array.from(EventListenerRegistry.getQueuesFor(PreviewGeneratedEvent))).toEqual([
      IMAGE_DESCRIPTION_QUEUE,
    ]);
  });

  it('throws instead of silently registering a second, mismatched declaration for the same queue', () => {
    expect(() =>
      EventListenerRegistry.register('some.other.event', 'RogueListener', 'handle', IMAGE_DESCRIPTION_QUEUE, {
        policy: 'standard',
      }),
    ).toThrow(/Conflicting queueOptions\.policy/);
  });
});

/**
 * The dedup rule below is read out of the installed pg-boss, not restated from
 * memory: `plans.create()` renders the very DDL that `create_queue` executes
 * for each queue partition, and `insertJob` is the statement `boss.send()`
 * runs. Modelling it by hand is how the previous version of this file managed
 * to "prove" a broken configuration correct — its helper typed `singletonKey`
 * as required, so the one shape that loses jobs could not even be expressed.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plans = require('pg-boss/src/plans') as {
  create(schema: string, version: number): string;
  insertJob(schema: string): string;
  QUEUE_POLICIES: Record<string, string>;
  JOB_STATES: Record<string, string>;
};

const SHORT_INDEX_SQL =
  /CREATE UNIQUE INDEX [^']*_i1 [^']*?\(name, COALESCE\(singleton_key, ''''\)\) WHERE state = ''created'' AND policy = ''short''/.exec(
    plans.create('pgboss', 25),
  )?.[0];

type Policy = 'standard' | 'short' | 'singleton' | 'stately';

interface SendOptions {
  // Optional, exactly as `EventSendOptions` has it — a keyless send is the
  // shape under test, so the type must be able to express it.
  singletonKey?: string;
}

/**
 * `boss.send()` against a queue whose partition carries the `job_i1` index:
 * returns the new job id, or `null` when the insert conflicted and was
 * discarded. `created` is the only state modelled because that is the index's
 * own predicate.
 */
function send(
  created: Array<{ queue: string; singletonKey: string }>,
  queue: string,
  policy: Policy | undefined,
  options: SendOptions = {},
): string | null {
  const singletonKey = options.singletonKey ?? '';

  if (policy === 'short' && created.some((row) => row.queue === queue && row.singletonKey === singletonKey)) {
    return null;
  }

  created.push({ queue, singletonKey });

  return `job-${created.length}`;
}

describe('pg-boss short-policy dedup, as the installed pg-boss defines it', () => {
  it('dedups on (name, COALESCE(singleton_key, \'\')) for created jobs on a "short" queue', () => {
    expect(SHORT_INDEX_SQL).toBeDefined();
    expect(plans.QUEUE_POLICIES.short).toBe('short');
    expect(plans.JOB_STATES.created).toBe('created');
  });

  it('discards the losing insert silently — no error, no dead letter', () => {
    expect(plans.insertJob('pgboss')).toContain('ON CONFLICT DO NOTHING');
  });

  it('collapses every KEYLESS send on a "short" queue into one job', () => {
    const created: Array<{ queue: string; singletonKey: string }> = [];

    expect(send(created, 'demo', 'short')).not.toBeNull();
    expect(send(created, 'demo', 'short')).toBeNull();
    expect(created).toHaveLength(1);
  });
});

const ownerCtx = { userId: 'owner-1' } as UserServiceContext;

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

/** Typed like `EventService.send` so the captured call carries its options. */
function makeEventService() {
  return {
    send: jest.fn(async (_name: string, _payload: unknown, _options?: SendOptions) => [] as string[]),
  };
}

describe('thing-vision: the real file.uploaded producer sends keyless', () => {
  /**
   * The producer is run for real (mocked repository and S3 only, as in
   * FileService.test.ts) so the send options under test are the ones
   * production actually builds — not a literal copied into the test, which
   * would keep passing after the producer changed.
   */
  async function captureUploadSends(): Promise<SendOptions[]> {
    const repo = {
      create: jest.fn((row: Record<string, unknown>) => row),
      save: jest.fn(async (row: Record<string, unknown>) => row),
      findOne: jest.fn(async () => null),
    };
    const eventService = makeEventService();
    const service = new FileService(repo as never, eventService as never, makeLogger() as never);

    (service as unknown as { s3: { send: jest.Mock } }).s3 = { send: jest.fn().mockResolvedValue({}) };

    for (const bytes of ['first upload', 'second upload']) {
      await service.uploadWithDedupInfo(ownerCtx, {
        filename: `${bytes}.jpg`,
        contentType: 'image/jpeg',
        size: bytes.length,
        buffer: Buffer.from(bytes),
        thingCapture: true,
      } as never);
    }

    return eventService.send.mock.calls
      .filter(([name]) => name === FileUploadedEvent)
      .map(([, , options]) => options ?? {});
  }

  it('enqueues both uploads under the declared policy', async () => {
    const sends = await captureUploadSends();

    expect(sends).toHaveLength(2);
    expect(sends.every((options) => options.singletonKey === undefined)).toBe(true);

    const created: Array<{ queue: string; singletonKey: string }> = [];
    const jobIds = sends.map((options) =>
      send(created, THING_VISION_QUEUE, THING_VISION_QUEUE_OPTIONS.policy, options),
    );

    expect(jobIds).not.toContain(null);
    expect(created).toHaveLength(2);
  });

  it('would have lost the second upload had the queue declared "short"', async () => {
    const sends = await captureUploadSends();
    const created: Array<{ queue: string; singletonKey: string }> = [];
    const jobIds = sends.map((options) => send(created, THING_VISION_QUEUE, 'short', options));

    expect(jobIds).toEqual([expect.any(String), null]);
  });
});

describe('image-description: live and backfill sends share one singletonKey', () => {
  // Any JPEG bytes will do: the decoder is stubbed below, since this suite is
  // about the send, not the pixels.
  const jpeg = readFileSync(join(__dirname, '../../../files/services/__tests__/__fixtures__/64x40.jpg'));

  async function livePreviewSend(previewId: string): Promise<SendOptions> {
    const fileService = {
      findVariantByParentId: jest.fn(async () => null),
      findById: jest.fn(async () => ({
        id: 'file-1',
        bucket: 'files',
        key: 'owner-1/file-1',
        contentType: 'image/jpeg',
        size: jpeg.length,
      })),
      getFileContent: jest.fn(async () => jpeg),
      setDimensions: jest.fn(async () => {}),
      create: jest.fn(async () => ({ id: previewId })),
    };
    const mediaDimensionsService = { fromImageBuffer: jest.fn(async () => ({ width: 64, height: 40 })) };
    const vips = { renderJpeg: jest.fn(async () => ({ buffer: jpeg, width: 64, height: 40 })) };
    const eventService = makeEventService();

    // The send under test now lives in FilePreviewService; the listener is the
    // upload-path trigger over it, so it is driven the same way as before.
    const listener = new FilePreviewGenerationListener(
      new FilePreviewService(
        fileService as never,
        mediaDimensionsService as never,
        vips as never,
        eventService as never,
        makeLogger() as never,
      ),
    );

    await listener.generatePreview({ fileId: 'file-1', userId: ownerCtx.userId } as never);

    const call = eventService.send.mock.calls.find(([name]) => name === PreviewGeneratedEvent);

    expect(call).toBeDefined();

    return call?.[2] ?? {};
  }

  async function backfillPreviewSend(previewId: string): Promise<SendOptions> {
    const fileService = {
      findUndescribedImagePreviews: jest.fn(async () => [{ previewId }]),
    };
    const eventService = makeEventService();

    const listener = new ImageDescriptionBackfillListener(
      fileService as never,
      eventService as never,
      makeLogger() as never,
    );

    await listener.handle({ userId: ownerCtx.userId });

    return eventService.send.mock.calls[0]?.[2] ?? {};
  }

  it('keys the live send on the preview id, so concurrent previews do not collapse under "short"', async () => {
    const first = await livePreviewSend('preview-1');
    const second = await livePreviewSend('preview-2');

    expect(first.singletonKey).toBe('image-description:preview-1');
    expect(second.singletonKey).toBe('image-description:preview-2');

    const created: Array<{ queue: string; singletonKey: string }> = [];
    const jobIds = [first, second].map((options) =>
      send(created, IMAGE_DESCRIPTION_QUEUE, IMAGE_DESCRIPTION_QUEUE_OPTIONS.policy, options),
    );

    expect(jobIds).not.toContain(null);
  });

  it('lets the declared "short" policy refuse a backfill re-drive of a preview already queued', async () => {
    const live = await livePreviewSend('preview-1');
    const backfill = await backfillPreviewSend('preview-1');

    expect(backfill.singletonKey).toBe(live.singletonKey);

    const created: Array<{ queue: string; singletonKey: string }> = [];

    expect(
      send(created, IMAGE_DESCRIPTION_QUEUE, IMAGE_DESCRIPTION_QUEUE_OPTIONS.policy, live),
    ).not.toBeNull();
    expect(
      send(created, IMAGE_DESCRIPTION_QUEUE, IMAGE_DESCRIPTION_QUEUE_OPTIONS.policy, backfill),
    ).toBeNull();
    expect(created).toHaveLength(1);
  });
});
