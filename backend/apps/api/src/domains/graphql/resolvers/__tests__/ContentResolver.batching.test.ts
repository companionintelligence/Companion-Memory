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
 * So assert the number of FileService calls, not the shape of the result.
 */

/** Real uuidv7s, so `classifyExternalId` sees a file-shaped external id. */
const FILE_IDS = Array.from(
  { length: 30 },
  (_unused, i) => `019ee82a-2f70-71fd-b4a7-2679a8e5${String(i).padStart(4, '0')}`,
);

function signedFile(id: string): SignedFile {
  return {
    id,
    parentId: null,
    variant: FileVariant.ORIGINAL,
    filename: null,
    contentType: 'image/jpeg',
    size: 1024,
    width: null,
    height: null,
    url: `/files/${id}.jpg`,
  } as unknown as SignedFile;
}

function makeHarness() {
  const findByIds = jest.fn(async (_ctx: unknown, ids: string[]) => ids.map((id) => signedFile(id)));
  const findVariantsByParentIds = jest.fn(async (_ctx: unknown, parentIds: string[]) =>
    parentIds.map(() => null),
  );

  const fileService = { findByIds, findVariantsByParentIds } as unknown as FileService;
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

  return { resolver, findByIds, findVariantsByParentIds };
}

function node(fileId: string, userId: string | null): ContentType {
  return {
    __source: { id: `content-${fileId}`, userId, externalId: fileId, externalIdKind: 'file' },
  } as unknown as ContentType;
}

/** All three media fields of every row, resolved concurrently as GraphQL does. */
function resolvePage(
  resolver: ContentResolver,
  context: RequestContext,
  nodes: ContentType[],
): Promise<unknown[]> {
  return Promise.all(
    nodes.flatMap((parent) => [
      resolver.previewUrl(context, parent),
      resolver.mediaUrl(context, parent),
      resolver.mediaSize(context, parent),
    ]),
  );
}

describe('ContentResolver media batching (query count)', () => {
  it('costs exactly one query per hop for a 30-row page x 3 fields, owner-scoped', async () => {
    const { resolver, findByIds, findVariantsByParentIds } = makeHarness();
    // A non-null userId is the ONLY case in this corpus: 0 of 44,749 media
    // content rows have a NULL user_id, so this is the live path.
    const context: RequestContext = { userId: 'user-1' };
    const nodes = FILE_IDS.map((id) => node(id, 'user-1'));

    await resolvePage(resolver, context, nodes);

    expect(findByIds).toHaveBeenCalledTimes(1);
    expect(findVariantsByParentIds).toHaveBeenCalledTimes(1);
    expect(findByIds.mock.calls[0][1]).toHaveLength(FILE_IDS.length);
    expect(findByIds.mock.calls[0][0]).toEqual({ userId: 'user-1' });
  });

  it('costs one query per hop when the rows carry no userId (viewer fallback)', async () => {
    const { resolver, findByIds, findVariantsByParentIds } = makeHarness();
    const context: RequestContext = { userId: 'viewer-1' };
    const nodes = FILE_IDS.map((id) => node(id, null));

    await resolvePage(resolver, context, nodes);

    expect(findByIds).toHaveBeenCalledTimes(1);
    expect(findVariantsByParentIds).toHaveBeenCalledTimes(1);
  });

  // Shared search is the one path that mixes owners in a single response; each
  // owner gets its own batch, and no owner gets more than one.
  it('batches per owner on a mixed-owner (shared search) page', async () => {
    const { resolver, findByIds, findVariantsByParentIds } = makeHarness();
    const context: RequestContext = { userId: 'viewer-1' };
    const nodes = FILE_IDS.map((id, i) => node(id, i % 2 === 0 ? 'owner-a' : 'owner-b'));

    await resolvePage(resolver, context, nodes);

    expect(findByIds).toHaveBeenCalledTimes(2);
    expect(findVariantsByParentIds).toHaveBeenCalledTimes(2);
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
