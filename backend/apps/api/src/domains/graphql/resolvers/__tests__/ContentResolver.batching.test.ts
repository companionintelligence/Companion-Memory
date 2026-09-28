import type { RequestContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { FileVariant, type FileService, type SignedFile } from '@ci/domains/files';

import { ContentFileLoader } from '../../loaders/ContentFileLoader';
import type { ContentType } from '../../types/ContentType';
import { ContentResolver } from '../ContentResolver';

/**
 * Measures the query cost of a page of media content rows through the REAL
 * resolver -> entityOwnerScope -> Loader -> DataLoader path, with only
 * FileService mocked.
 *
 * This exists because the loader-level test (ContentFileLoader.test.ts) passes
 * one shared context object straight to `loader.load`, which is exactly the
 * condition the production path did NOT satisfy: `entityOwnerScope` used to
 * return a fresh `{ userId }` literal per call, and `Loader.getLoader` caches
 * its DataLoaders in a `WeakMap` keyed by that object's identity. Every field
 * on every row therefore built its own DataLoader and dispatched a batch of
 * one — 2 queries x 3 fields x N rows. The loader test could never see it.
 *
 * So assert the number of FileService calls, not only the shape of the result.
 * The variants hop counts BOTH FileService variant methods: the PLAYBACK
 * rendition sits beside the PREVIEW, and fetching it with a second
 * single-kind call is one more query per page — the same regression in a
 * smaller size.
 */

/** Real uuidv7s, so `classifyExternalId` sees a file-shaped external id. */
const FILE_IDS = Array.from(
  { length: 30 },
  (_unused, i) => `019ee82a-2f70-71fd-b4a7-2679a8e5${String(i).padStart(4, '0')}`,
);

function signedFile(id: string, variant = FileVariant.ORIGINAL, parentId: string | null = null): SignedFile {
  return {
    id,
    parentId,
    variant,
    filename: null,
    contentType: variant === FileVariant.PLAYBACK ? 'video/mp4' : 'image/jpeg',
    size: 1024,
    width: null,
    height: null,
    url: `/files/${id}.${variant === FileVariant.PLAYBACK ? 'mp4' : 'jpg'}`,
  } as unknown as SignedFile;
}

function makeHarness() {
  const findByIds = jest.fn(async (_ctx: unknown, ids: string[]) => ids.map((id) => signedFile(id)));
  // Every original has both derivatives, so a kind that went missing on the
  // way through the loader shows up as a null field below.
  const findVariantsOfKindsByParentIds = jest.fn(
    async (_ctx: unknown, parentIds: string[], variants: readonly FileVariant[]) =>
      Object.fromEntries(
        variants.map((variant) => [
          variant,
          parentIds.map((parentId) => signedFile(`${variant}-${parentId}`, variant, parentId)),
        ]),
      ),
  );
  // The single-kind lookup, stubbed so that a loader going back to one call
  // per kind is caught by the count below rather than by a TypeError.
  const findVariantsByParentIds = jest.fn(async (_ctx: unknown, parentIds: string[], variant: FileVariant) =>
    parentIds.map((parentId) => signedFile(`${variant}-${parentId}`, variant, parentId)),
  );
  const variantQueries = () =>
    findVariantsOfKindsByParentIds.mock.calls.length + findVariantsByParentIds.mock.calls.length;

  const fileService = {
    findByIds,
    findVariantsOfKindsByParentIds,
    findVariantsByParentIds,
  } as unknown as FileService;
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;

  const contentFileLoader = new ContentFileLoader(fileService, logger);

  const resolver = new ContentResolver(
    {} as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
    contentFileLoader,
    { load: jest.fn() } as never,
  );

  return { resolver, findByIds, findVariantsOfKindsByParentIds, variantQueries };
}

function node(fileId: string, userId: string | null): ContentType {
  return {
    __source: { id: `content-${fileId}`, userId, externalId: fileId, externalIdKind: 'file' },
  } as unknown as ContentType;
}

/** The media fields of every row, resolved concurrently as GraphQL does. */
function resolvePage(
  resolver: ContentResolver,
  context: RequestContext,
  nodes: ContentType[],
): Promise<unknown[]> {
  return Promise.all(
    nodes.flatMap((parent) => [
      resolver.previewUrl(context, parent),
      resolver.mediaUrl(context, parent),
      resolver.playbackUrl(context, parent),
      resolver.playbackContentType(context, parent),
      resolver.mediaSize(context, parent),
    ]),
  );
}

/** Fields resolved per row by {@link resolvePage}, in its order. */
const FIELDS_PER_ROW = 5;

describe('ContentResolver media batching (query count)', () => {
  it('costs exactly one query per hop for a 30-row page x 5 fields, owner-scoped', async () => {
    const { resolver, findByIds, findVariantsOfKindsByParentIds, variantQueries } = makeHarness();
    // A non-null userId is the ONLY case in this corpus: 0 of 44,749 media
    // content rows have a NULL user_id, so this is the live path.
    const context: RequestContext = { userId: 'user-1' };
    const nodes = FILE_IDS.map((id) => node(id, 'user-1'));

    await resolvePage(resolver, context, nodes);

    expect(findByIds).toHaveBeenCalledTimes(1);
    expect(variantQueries()).toBe(1);
    expect(findByIds.mock.calls[0][1]).toHaveLength(FILE_IDS.length);
    expect(findByIds.mock.calls[0][0]).toEqual({ userId: 'user-1' });
    // …and that one query asks for both derivatives of the whole page.
    expect(findVariantsOfKindsByParentIds).toHaveBeenCalledWith({ userId: 'user-1' }, FILE_IDS, [
      FileVariant.PREVIEW,
      FileVariant.PLAYBACK,
    ]);
  });

  // One query must still carry both kinds back to the right row: a thumbnail
  // and a playable rendition per original, neither dropped nor swapped.
  it('returns the PREVIEW and the PLAYBACK of every row from the one variants query', async () => {
    const { resolver, variantQueries } = makeHarness();
    const context: RequestContext = { userId: 'user-1' };
    const nodes = FILE_IDS.map((id) => node(id, 'user-1'));

    const values = await resolvePage(resolver, context, nodes);

    expect(variantQueries()).toBe(1);
    FILE_IDS.forEach((id, row) => {
      const [previewUrl, mediaUrl, playbackUrl, playbackContentType, mediaSize] = values.slice(
        row * FIELDS_PER_ROW,
        (row + 1) * FIELDS_PER_ROW,
      );

      expect({ previewUrl, mediaUrl, playbackUrl, playbackContentType, mediaSize }).toEqual({
        previewUrl: `/files/${FileVariant.PREVIEW}-${id}.jpg`,
        mediaUrl: `/files/${id}.jpg`,
        playbackUrl: `/files/${FileVariant.PLAYBACK}-${id}.mp4`,
        playbackContentType: 'video/mp4',
        mediaSize: 1024,
      });
    });
  });

  it('costs one query per hop when the rows carry no userId (viewer fallback)', async () => {
    const { resolver, findByIds, variantQueries } = makeHarness();
    const context: RequestContext = { userId: 'viewer-1' };
    const nodes = FILE_IDS.map((id) => node(id, null));

    await resolvePage(resolver, context, nodes);

    expect(findByIds).toHaveBeenCalledTimes(1);
    expect(variantQueries()).toBe(1);
  });

  // Shared search is the one path that mixes owners in a single response; each
  // owner gets its own batch, and no owner gets more than one.
  it('batches per owner on a mixed-owner (shared search) page', async () => {
    const { resolver, findByIds, variantQueries } = makeHarness();
    const context: RequestContext = { userId: 'viewer-1' };
    const nodes = FILE_IDS.map((id, i) => node(id, i % 2 === 0 ? 'owner-a' : 'owner-b'));

    await resolvePage(resolver, context, nodes);

    expect(findByIds).toHaveBeenCalledTimes(2);
    expect(variantQueries()).toBe(2);
    expect(findByIds.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([{ userId: 'owner-a' }, { userId: 'owner-b' }]),
    );
    expect(findByIds.mock.calls.map((call) => (call[1] as string[]).length).sort()).toEqual([15, 15]);
  });

  // Two separate requests must not share a batch or a cache entry — the memo is
  // keyed on the RequestContext object, which dies with the request.
  it('does not reuse one request’s loader for the next request', async () => {
    const { resolver, findByIds } = makeHarness();
    const nodes = FILE_IDS.slice(0, 2).map((id) => node(id, 'user-1'));

    await resolvePage(resolver, { userId: 'user-1' }, nodes);
    await resolvePage(resolver, { userId: 'user-1' }, nodes);

    expect(findByIds).toHaveBeenCalledTimes(2);
  });
});
