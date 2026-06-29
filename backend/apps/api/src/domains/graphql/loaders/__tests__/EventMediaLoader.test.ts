import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { FileVariant, type FileService, type SignedFile } from '@ci/domains/files';
import type { ContentService } from '@ci/domains/memory';

import { EventMediaLoader } from '../EventMediaLoader';

/**
 * The loader walks event -> ci.content -> ORIGINAL file -> PREVIEW file with
 * every hop batched once per request. These tests mock the two services and
 * assert the assembly: the right URLs/dims land on the right event, missing
 * links resolve to null, and a page of events triggers exactly one query each.
 */

type MediaLink = { eventId: string; fileId: string; mimetype: string | null };

function signedFile(partial: Partial<SignedFile> & { id: string }): SignedFile {
  return {
    parentId: null,
    variant: FileVariant.ORIGINAL,
    filename: null,
    contentType: 'image/jpeg',
    size: null,
    width: null,
    height: null,
    url: null,
    ...partial,
  } as SignedFile;
}

function makeServices(opts: { links: MediaLink[]; originals: SignedFile[]; previews: SignedFile[] }) {
  const findMediaFilesByEventIds = jest.fn(async () => opts.links);
  const findByIds = jest.fn(async (_ctx: unknown, ids: string[]) =>
    ids.map((id) => opts.originals.find((f) => f.id === id) ?? null),
  );
  const findVariantsByParentIds = jest.fn(async (_ctx: unknown, parentIds: string[]) =>
    parentIds.map((pid) => opts.previews.find((f) => f.parentId === pid) ?? null),
  );

  const contentService = { findMediaFilesByEventIds } as unknown as ContentService;
  const fileService = { findByIds, findVariantsByParentIds } as unknown as FileService;
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;

  const loader = new EventMediaLoader(contentService, fileService, logger);

  return { loader, findMediaFilesByEventIds, findByIds, findVariantsByParentIds };
}

const CTX = { userId: 'user-1' } as UserServiceContext;

describe('EventMediaLoader', () => {
  it('assembles preview + original URLs, content type and size onto the event', async () => {
    const { loader } = makeServices({
      links: [{ eventId: 'evt-photo', fileId: 'file-1', mimetype: 'image/jpeg' }],
      originals: [
        signedFile({ id: 'file-1', contentType: 'image/png', size: 2048, url: '/companion/orig?sig' }),
      ],
      previews: [signedFile({ id: 'prev-1', parentId: 'file-1', url: '/companion/prev?sig' })],
    });

    const media = await loader.load(CTX, 'evt-photo');

    expect(media).toEqual({
      previewUrl: '/companion/prev?sig',
      mediaUrl: '/companion/orig?sig',
      // The original file's content type wins over the content row's mimetype.
      contentType: 'image/png',
      width: null,
      height: null,
      size: 2048,
    });
  });

  it('returns null for an event with no linked media', async () => {
    const { loader } = makeServices({ links: [], originals: [], previews: [] });

    expect(await loader.load(CTX, 'evt-calendar')).toBeNull();
  });

  it('still resolves when only the original exists (no preview generated yet)', async () => {
    const { loader } = makeServices({
      links: [{ eventId: 'evt-vid', fileId: 'file-2', mimetype: 'video/mp4' }],
      originals: [signedFile({ id: 'file-2', contentType: 'video/mp4', url: '/companion/vid?sig' })],
      previews: [],
    });

    const media = await loader.load(CTX, 'evt-vid');

    expect(media?.previewUrl).toBeNull();
    expect(media?.mediaUrl).toBe('/companion/vid?sig');
    expect(media?.contentType).toBe('video/mp4');
  });

  it('falls back to the content row mimetype when the original is unresolvable', async () => {
    // Link points at a file the user can't see (deleted / other user) but a
    // preview survives — content type still comes through from the content row.
    const { loader } = makeServices({
      links: [{ eventId: 'evt-x', fileId: 'gone', mimetype: 'image/heic' }],
      originals: [],
      previews: [signedFile({ id: 'prev-x', parentId: 'gone', url: '/companion/prev-x?sig' })],
    });

    const media = await loader.load(CTX, 'evt-x');

    expect(media?.previewUrl).toBe('/companion/prev-x?sig');
    expect(media?.mediaUrl).toBeNull();
    expect(media?.contentType).toBe('image/heic');
  });

  it('batches a page of events into one query per hop', async () => {
    const { loader, findMediaFilesByEventIds, findByIds, findVariantsByParentIds } = makeServices({
      links: [
        { eventId: 'a', fileId: 'fa', mimetype: 'image/jpeg' },
        { eventId: 'b', fileId: 'fb', mimetype: 'image/jpeg' },
      ],
      originals: [
        signedFile({ id: 'fa', url: '/companion/a?sig' }),
        signedFile({ id: 'fb', url: '/companion/b?sig' }),
      ],
      previews: [
        signedFile({ id: 'pa', parentId: 'fa', url: '/companion/pa?sig' }),
        signedFile({ id: 'pb', parentId: 'fb', url: '/companion/pb?sig' }),
      ],
    });

    const [a, b, c] = await Promise.all([
      loader.load(CTX, 'a'),
      loader.load(CTX, 'b'),
      loader.load(CTX, 'c'), // no link -> null, but shares the same batch
    ]);

    expect(a?.previewUrl).toBe('/companion/pa?sig');
    expect(b?.previewUrl).toBe('/companion/pb?sig');
    expect(c).toBeNull();

    // One round-trip each, not one per event.
    expect(findMediaFilesByEventIds).toHaveBeenCalledTimes(1);
    expect(findByIds).toHaveBeenCalledTimes(1);
    expect(findVariantsByParentIds).toHaveBeenCalledTimes(1);
    expect(findMediaFilesByEventIds).toHaveBeenCalledWith(CTX, ['a', 'b', 'c']);
  });
});
