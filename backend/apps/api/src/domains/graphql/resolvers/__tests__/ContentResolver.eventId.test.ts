import { BadRequestException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import { ContentResolver, CREATE_CONTENTS_MAX_BATCH, resolveEventId } from '../ContentResolver';

describe('resolveEventId', () => {
  const uuid = '019ee82a-2f70-71fd-b4a7-2679a8e5140b';

  it('decodes a relay global id (what createEvent returns) to the raw uuid', () => {
    const globalId = GlobalUID.encode('event', uuid);
    expect(resolveEventId(globalId)).toBe(uuid);
  });

  it('passes a bare uuid through unchanged', () => {
    expect(resolveEventId(uuid)).toBe(uuid);
  });

  it('does not mis-decode a global id of another type — leaves it untouched', () => {
    const personGlobalId = GlobalUID.encode('person', uuid);
    // Not an event id; resolveEventId returns it as-is rather than stealing the uuid.
    expect(resolveEventId(personGlobalId)).toBe(personGlobalId);
  });
});

/**
 * WS3 resolver contract: the batch createContents runs as one set-based
 * transaction, so it is guarded by CREATE_CONTENTS_MAX_BATCH; and the single
 * createContent routes through createMany with { emitCreated: true } so an
 * interactive create still indexes live.
 */
describe('ContentResolver — createContents batch cap + createContent live-index wiring', () => {
  const ctx = { userId: 'user-1' } as unknown as RequestContext;

  const makeResolver = () => {
    // Explicitly typed with a trailing options arg so `.mock.calls[0][2]` is
    // inspectable; echoes a minimal egress row per input so ContentType.toType
    // is happy. Untyped params would give the mock a 2-tuple call signature.
    const createMany: jest.Mock<
      Promise<{ id: string; type: string }[]>,
      [unknown, unknown[], { emitCreated?: boolean }?]
    > = jest.fn(async (_c, rows) => rows.map((_r, i) => ({ id: `content-${i}`, type: 'note' })));
    const contentService = { createMany };
    const resolver = new ContentResolver(
      contentService as never,
      { load: jest.fn() } as never,
      { load: jest.fn() } as never,
    );

    return { resolver, contentService };
  };

  it('accepts a batch at exactly the cap', async () => {
    const { resolver, contentService } = makeResolver();
    const input = Array.from({ length: CREATE_CONTENTS_MAX_BATCH }, () => ({ type: 'note' }));

    await expect(resolver.createContents(ctx, input as never)).resolves.toHaveLength(
      CREATE_CONTENTS_MAX_BATCH,
    );
    expect(contentService.createMany).toHaveBeenCalledTimes(1);
  });

  it('rejects a batch one over the cap before touching the service', async () => {
    const { resolver, contentService } = makeResolver();
    const input = Array.from({ length: CREATE_CONTENTS_MAX_BATCH + 1 }, () => ({ type: 'note' }));

    await expect(resolver.createContents(ctx, input as never)).rejects.toBeInstanceOf(BadRequestException);
    // The oversized batch never reaches the service.
    expect(contentService.createMany).not.toHaveBeenCalled();
  });

  it('single createContent routes through createMany with emitCreated:true (live indexing)', async () => {
    const { resolver, contentService } = makeResolver();

    await resolver.createContent(ctx, { type: 'note', text: 'hi' } as never);

    expect(contentService.createMany).toHaveBeenCalledTimes(1);
    // 3rd arg is the options object opting this interactive create into live indexing.
    expect(contentService.createMany.mock.calls[0][2]).toEqual({ emitCreated: true });
  });
});
