import { type RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import { AnswerResolver } from '../AnswerResolver';
import { ContentResolver } from '../ContentResolver';
import { EventResolver } from '../EventResolver';
import { PlaceResolver } from '../PlaceResolver';
import { QuestionResolver } from '../QuestionResolver';

/**
 * Id-shape contract for the destructive mutations.
 *
 * Every read path (`event(id:)`, `EventType.id`, cursors, …) speaks Relay-style
 * GlobalUIDs, so a caller only ever *holds* a GlobalUID. These mutations used to
 * take the raw uuid instead, which meant handing back the id you were given blew
 * up — or, worse, matched nothing and reported a quiet `false`. Nothing called
 * them yet, so the mismatch stayed invisible; delete UI is what surfaces it.
 *
 * These tests pin three things per mutation:
 *   1. a GlobalUID is decoded, and the *raw* uuid reaches the service;
 *   2. a bare uuid is rejected rather than silently missing;
 *   3. a GlobalUID minted for a different resource type is rejected, so e.g. a
 *      place id cannot delete the event that happens to share its uuid.
 */

const context = { userId: 'user-1' } as unknown as RequestContext;

const RAW_ID = '550e8400-e29b-41d4-a716-446655440000';

type ResourceType = Parameters<typeof GlobalUID.encode>[0];

type Harness = { call: (id: string) => Promise<unknown>; service: jest.Mock };

type Case = {
  name: string;
  /** Resource type this mutation's ids must carry. */
  resource: ResourceType;
  /** A different resource type, to prove the type tag is enforced. */
  otherResource: ResourceType;
  /** Builds the resolver over a mocked service and exposes the mocked method. */
  build: () => Harness;
};

function answerCase(method: 'remove' | 'update'): Harness {
  const service = jest.fn().mockResolvedValue(method === 'remove' ? true : null);
  const resolver = new AnswerResolver({ [method]: service } as never, undefined as never);

  return {
    service,
    call: (id: string) =>
      method === 'remove'
        ? resolver.removeAnswer(context, id)
        : resolver.updateAnswer(context, { id, answer: 'a' }),
  };
}

function questionCase(method: 'remove' | 'update'): Harness {
  const service = jest.fn().mockResolvedValue(method === 'remove' ? true : null);
  const resolver = new QuestionResolver({ [method]: service } as never);

  return {
    service,
    call: (id: string) =>
      method === 'remove'
        ? resolver.removeQuestion(context, id)
        : resolver.updateQuestion(context, { id, text: 't', category: 'c' }),
  };
}

const cases: Case[] = [
  { name: 'removeAnswer', resource: 'answer', otherResource: 'question', build: () => answerCase('remove') },
  { name: 'updateAnswer', resource: 'answer', otherResource: 'question', build: () => answerCase('update') },
  {
    name: 'removeContent',
    resource: 'content',
    otherResource: 'event',
    build: () => {
      const service = jest.fn().mockResolvedValue(true);
      const resolver = new ContentResolver(
        { remove: service } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
      );

      return { service, call: (id: string) => resolver.removeContent(context, id) };
    },
  },
  {
    name: 'removeEvent',
    resource: 'event',
    otherResource: 'place',
    build: () => {
      const service = jest.fn().mockResolvedValue(true);
      const resolver = new EventResolver(
        { remove: service } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
      );

      return { service, call: (id: string) => resolver.removeEvent(context, id) };
    },
  },
  {
    name: 'removePlace',
    resource: 'place',
    otherResource: 'event',
    build: () => {
      const service = jest.fn().mockResolvedValue(true);
      const resolver = new PlaceResolver(
        { remove: service } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
      );

      return { service, call: (id: string) => resolver.removePlace(context, id) };
    },
  },
  {
    name: 'removeQuestion',
    resource: 'question',
    otherResource: 'answer',
    build: () => questionCase('remove'),
  },
  {
    name: 'updateQuestion',
    resource: 'question',
    otherResource: 'answer',
    build: () => questionCase('update'),
  },
];

describe.each(cases)('$name id shape', ({ resource, otherResource, build }) => {
  it('decodes the GlobalUID a caller holds and passes the raw uuid to the service', async () => {
    const { call, service } = build();

    await call(GlobalUID.encode(resource, RAW_ID));

    expect(service).toHaveBeenCalledTimes(1);
    expect(service.mock.calls[0][1]).toBe(RAW_ID);
  });

  it('rejects a bare uuid instead of silently matching nothing', async () => {
    const { call, service } = build();

    await expect(call(RAW_ID)).rejects.toThrow('Invalid global id format');
    expect(service).not.toHaveBeenCalled();
  });

  it('rejects a GlobalUID minted for a different resource type', async () => {
    const { call, service } = build();

    await expect(call(GlobalUID.encode(otherResource, RAW_ID))).rejects.toThrow('Unexpected global id type');
    expect(service).not.toHaveBeenCalled();
  });
});
