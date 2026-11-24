import { BadRequestException } from '@nestjs/common';

import type { RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import { FileResolver } from '../FileResolver';

/**
 * `file(id:)` for an ORIGINAL image row.
 *
 * The iOS QA run (MEM-06) asked `file(id: "<ci.files.id of an ORIGINAL>")` and got
 * "Internal server error". The row was fine: the id was the raw uuid, and `file`
 * takes the global id every other read path hands out (`FileType.id`). A bare uuid
 * is refused on purpose — see mutationGlobalIds.test.ts — but it has to read as the
 * caller's mistake (a 400), not as a server fault.
 */
const context = { userId: 'user-1' } as unknown as RequestContext;

const ORIGINAL_ID = '01a0fb20-60d3-76a9-a2f4-f5cec8a645fe';

function originalImage() {
  return {
    id: ORIGINAL_ID,
    userId: 'user-1',
    filename: 'IMG_0111.jpeg',
    contentType: 'image/jpeg',
    size: 4_127_524,
    title: null,
    description: null,
    externalId: null,
    url: '/companion/original-key?X-Amz-Signature=sig',
    parseStatus: null,
    parseError: null,
    parsedAt: null,
    createdAt: new Date('2026-10-02T16:24:49.000Z'),
    updatedAt: new Date('2026-10-02T16:24:49.000Z'),
  };
}

function makeResolver(found: ReturnType<typeof originalImage> | null) {
  const findById = jest.fn().mockResolvedValue(found);
  const resolver = new FileResolver(
    { findById } as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
  );

  return { resolver, findById };
}

describe('FileResolver.file', () => {
  it('resolves an ORIGINAL image by its global id, with the raw uuid reaching the service', async () => {
    const { resolver, findById } = makeResolver(originalImage());

    const file = await resolver.file(context, GlobalUID.encode('file', ORIGINAL_ID));

    expect(findById).toHaveBeenCalledTimes(1);
    expect(findById.mock.calls[0][1]).toBe(ORIGINAL_ID);
    expect(file).toMatchObject({
      id: GlobalUID.encode('file', ORIGINAL_ID),
      filename: 'IMG_0111.jpeg',
      contentType: 'image/jpeg',
      sourceUrl: '/companion/original-key?X-Amz-Signature=sig',
    });
  });

  it('answers null for a global id that matches no file of the caller', async () => {
    const { resolver } = makeResolver(null);

    await expect(resolver.file(context, GlobalUID.encode('file', ORIGINAL_ID))).resolves.toBeNull();
  });

  it('refuses the bare uuid as a bad request, without touching the service', async () => {
    const { resolver, findById } = makeResolver(originalImage());

    await expect(resolver.file(context, ORIGINAL_ID)).rejects.toThrow(BadRequestException);
    await expect(resolver.file(context, ORIGINAL_ID)).rejects.toThrow('Invalid global id format');
    expect(findById).not.toHaveBeenCalled();
  });
});
