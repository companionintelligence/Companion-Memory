import { ContextService, type RequestContext } from '@ci/common/context';

import { GlobalUID } from '../../types/GlobalUID';
import { NodeResolver } from '../NodeResolver';

/**
 * `node(id: "file-chunk:<uuid>")` hands back a chunk's parsed document text.
 * Every other branch of `node` resolves through a finder scoped to the caller;
 * this one used to read the chunk by id alone and return it even when the
 * caller's own lookup of the parent file came back empty. The owner check on
 * the chunk itself is `DocumentChunkService`'s and is exercised against real
 * Postgres in `DocumentChunkService.ownerScope.integration.spec.ts`; this pins
 * what the resolver does with it.
 */

const ME = '00000000-0000-4000-8000-0000000000aa';
const CHUNK_ID = '00000000-0000-7000-8000-0000000000c1';
const FILE_ID = '00000000-0000-7000-8000-0000000000f1';

const chunk = {
  id: CHUNK_ID,
  fileId: FILE_ID,
  userId: ME,
  chunkIndex: 0,
  content: 'Page one of the lease.',
  sectionTitle: null,
  sourceLocator: null,
  parserName: 'spec',
  parserVersion: '1',
  chunkerVersion: '1',
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
};

function buildResolver(options: { chunks: unknown[]; file: unknown }) {
  const fileChunkService = { findByIds: jest.fn(async () => options.chunks) };
  const fileService = { findById: jest.fn(async () => options.file) };
  const services: unknown[] = Array.from({ length: 25 }, () => ({}));

  // Constructor order: ..., eventService (7), fileChunkService (8), fileService (9), ...
  services[8] = fileChunkService;
  services[9] = fileService;

  const resolver = new (NodeResolver as unknown as new (...args: unknown[]) => NodeResolver)(...services);

  return { resolver, fileChunkService, fileService };
}

const context: RequestContext = { userId: ME };

function asCaller<T>(fn: () => Promise<T>): Promise<T> {
  return ContextService.run({ traceId: 'test', userId: ME }, fn);
}

describe('NodeResolver.node for a file chunk', () => {
  const gid = GlobalUID.encode('file-chunk', CHUNK_ID);

  it("asks for the chunk as the caller, not across every user's chunks", async () => {
    const { resolver, fileChunkService } = buildResolver({ chunks: [chunk], file: { id: FILE_ID } });

    await asCaller(() => resolver.node(context, gid));

    expect(fileChunkService.findByIds).toHaveBeenCalledWith({ userId: ME }, [CHUNK_ID]);
  });

  it('returns nothing when the chunk is not the caller’s', async () => {
    const { resolver, fileService } = buildResolver({ chunks: [], file: null });

    await expect(asCaller(() => resolver.node(context, gid))).resolves.toBeNull();
    expect(fileService.findById).not.toHaveBeenCalled();
  });

  it('returns nothing when the caller cannot see the file the chunk came from', async () => {
    const { resolver, fileService } = buildResolver({ chunks: [chunk], file: null });

    await expect(asCaller(() => resolver.node(context, gid))).resolves.toBeNull();
    expect(fileService.findById).toHaveBeenCalledWith({ userId: ME }, FILE_ID);
  });

  it('returns the chunk with its file when both are the caller’s', async () => {
    const { resolver } = buildResolver({ chunks: [chunk], file: { id: FILE_ID, filename: 'lease.pdf' } });

    const node = (await asCaller(() => resolver.node(context, gid))) as unknown as {
      content: string;
      file: { filename: string } | null;
    };

    expect(node.content).toBe('Page one of the lease.');
    expect(node.file?.filename).toBe('lease.pdf');
  });
});
