import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { FileVariant, type FileService, type SignedFile } from '@ci/domains/files';

import { ContentFileLoader } from '../ContentFileLoader';

/**
 * The loader is the second half of {@link EventMediaLoader}'s walk, entered
 * from a content row instead of an event: file id -> ORIGINAL + PREVIEW +
 * PLAYBACK. These tests mock FileService and assert the assembly — the right
 * URLs land on the right file id, an unresolvable id yields null rather than a
 * half-empty object, and a page of content rows costs one query per hop.
 */

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

function makeLoader(opts: { originals: SignedFile[]; previews: SignedFile[]; playbacks?: SignedFile[] }) {
  const findByIds = jest.fn(async (_ctx: unknown, ids: string[]) =>
    ids.map((id) => opts.originals.find((f) => f.id === id) ?? null),
  );
  const findVariantsOfKindsByParentIds = jest.fn(
    async (_ctx: unknown, parentIds: string[], variants: readonly FileVariant[]) =>
      Object.fromEntries(
        variants.map((variant) => [
          variant,
          parentIds.map(
            (pid) =>
              (variant === FileVariant.PLAYBACK ? (opts.playbacks ?? []) : opts.previews).find(
                (f) => f.parentId === pid,
              ) ?? null,
          ),
        ]),
      ),
  );

  const fileService = { findByIds, findVariantsOfKindsByParentIds } as unknown as FileService;
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;

  return { loader: new ContentFileLoader(fileService, logger), findByIds, findVariantsOfKindsByParentIds };
}

const CTX = { userId: 'user-1' } as UserServiceContext;

describe('ContentFileLoader', () => {
  it('assembles the preview + original URLs, content type and size for a file id', async () => {
    const { loader } = makeLoader({
      originals: [
        signedFile({
          id: 'file-1',
          url: '/files/IMGP0463.JPG',
          filename: 'IMGP0463.JPG',
          contentType: 'image/jpeg',
          size: 4_194_304 as unknown as number,
        }),
      ],
      previews: [
        signedFile({
          id: 'preview-1',
          parentId: 'file-1',
          variant: FileVariant.PREVIEW,
          url: '/files/IMGP0463-thumb.jpg',
        }),
      ],
    });

    await expect(loader.load(CTX, 'file-1')).resolves.toEqual({
      previewUrl: '/files/IMGP0463-thumb.jpg',
      mediaUrl: '/files/IMGP0463.JPG',
      playbackUrl: null,
      playbackContentType: null,
      contentType: 'image/jpeg',
      filename: 'IMGP0463.JPG',
      size: 4_194_304,
    });
  });

  // 70% of this corpus's media originals have no PREVIEW variant yet.
  it('returns a null previewUrl when no PREVIEW variant has been generated', async () => {
    const { loader } = makeLoader({
      originals: [signedFile({ id: 'file-2', url: '/files/raw.png', contentType: 'image/png' })],
      previews: [],
    });

    await expect(loader.load(CTX, 'file-2')).resolves.toMatchObject({
      previewUrl: null,
      mediaUrl: '/files/raw.png',
    });
  });

  // A UUID-shaped external_id that is not actually a ci.files id (or whose blob
  // was purged) must resolve to no media at all, not an object of nulls the
  // client would try to render.
  it('resolves to null when neither an original nor a preview exists', async () => {
    const { loader } = makeLoader({ originals: [], previews: [] });

    await expect(loader.load(CTX, 'file-missing')).resolves.toBeNull();
  });

  it('batches a page of content rows into one query per hop', async () => {
    const { loader, findByIds, findVariantsOfKindsByParentIds } = makeLoader({
      originals: [
        signedFile({ id: 'file-a', url: '/files/a.jpg' }),
        signedFile({ id: 'file-b', url: '/files/b.jpg' }),
      ],
      previews: [],
    });

    const results = await Promise.all([
      loader.load(CTX, 'file-a'),
      loader.load(CTX, 'file-b'),
      // Two content rows pointing at the same binary collapse to one key.
      loader.load(CTX, 'file-a'),
    ]);

    expect(results.map((r) => r?.mediaUrl)).toEqual(['/files/a.jpg', '/files/b.jpg', '/files/a.jpg']);
    expect(findByIds).toHaveBeenCalledTimes(1);
    // PREVIEW and PLAYBACK share the one variants query.
    expect(findVariantsOfKindsByParentIds).toHaveBeenCalledTimes(1);
    expect(findByIds.mock.calls[0][1]).toEqual(['file-a', 'file-b']);
  });

  it('requests the PREVIEW and PLAYBACK variants, and no other derivative', async () => {
    const { loader, findVariantsOfKindsByParentIds } = makeLoader({
      originals: [signedFile({ id: 'file-c', url: '/files/c.jpg' })],
      previews: [],
    });

    await loader.load(CTX, 'file-c');

    expect(findVariantsOfKindsByParentIds).toHaveBeenCalledWith(
      CTX,
      ['file-c'],
      [FileVariant.PREVIEW, FileVariant.PLAYBACK],
    );
    expect(findVariantsOfKindsByParentIds).toHaveBeenCalledTimes(1);
  });

  it('carries the PLAYBACK rendition for a video that has one', async () => {
    const { loader } = makeLoader({
      originals: [signedFile({ id: 'file-v', url: '/files/clip.mov', contentType: 'video/quicktime' })],
      previews: [],
      playbacks: [
        signedFile({
          id: 'play-v',
          parentId: 'file-v',
          variant: FileVariant.PLAYBACK,
          contentType: 'video/mp4',
          url: '/files/clip-h264.mp4',
        }),
      ],
    });

    await expect(loader.load(CTX, 'file-v')).resolves.toMatchObject({
      mediaUrl: '/files/clip.mov',
      contentType: 'video/quicktime',
      playbackUrl: '/files/clip-h264.mp4',
      playbackContentType: 'video/mp4',
    });
  });
});
