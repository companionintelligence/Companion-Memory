import { MediaDimensionsBackfillListener } from '../MediaDimensionsBackfillListener';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

interface Row {
  id: string;
  key: string;
  content_type: string;
}

/**
 * A QueryBuilder spy that records the candidate filter clauses and returns a
 * scripted sequence of pages from getRawMany (one array per keyset page).
 */
function makeQueryBuilder(pages: Row[][]) {
  const clauses: string[] = [];
  const queue = [...pages];
  const qb: Record<string, jest.Mock> = {};
  const chain = () => qb;
  qb.select = jest.fn(chain);
  qb.addSelect = jest.fn(chain);
  qb.where = jest.fn((c: string) => {
    clauses.push(c);

    return qb;
  });
  qb.andWhere = jest.fn((c: string) => {
    clauses.push(c);

    return qb;
  });
  qb.orderBy = jest.fn(chain);
  qb.limit = jest.fn(chain);
  qb.getRawMany = jest.fn(async () => queue.shift() ?? []);

  return { qb, clauses };
}

function makeListener(pages: Row[][]) {
  const builder = makeQueryBuilder(pages);
  const fileRepository = { createQueryBuilder: jest.fn(() => builder.qb) };

  const setDimensions = jest.fn(async () => {});
  const fileService = {
    setDimensions,
    getFileContent: jest.fn(async () => new Uint8Array([1, 2, 3])),
    getFileStream: jest.fn(async () => ({ pipe: jest.fn() })),
  };

  // Probes default to "couldn't read"; each test overrides with concrete dims.
  const mediaDimensionsService = {
    fromImageBuffer: jest.fn(async () => null as { width: number; height: number } | null),
    fromVideoStream: jest.fn(async () => null as { width: number; height: number } | null),
  };

  const listener = new MediaDimensionsBackfillListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileRepository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fileService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mediaDimensionsService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    makeLogger() as any,
  );

  return { listener, builder, fileService, mediaDimensionsService, setDimensions };
}

const USER = '00000000-0000-0000-0000-0000000000aa';

function imageRow(id: string): Row {
  return { id, key: `key-${id}`, content_type: 'image/jpeg' };
}

describe('MediaDimensionsBackfillListener.handleBatch', () => {
  it('records dimensions for a resolvable image via setDimensions', async () => {
    const rows = [imageRow('a'), imageRow('b')];
    const { listener, fileService, mediaDimensionsService, setDimensions } = makeListener([rows, []]);
    mediaDimensionsService.fromImageBuffer.mockResolvedValue({ width: 1024, height: 768 });

    await listener.handleBatch({ userId: USER, limit: 10 });

    expect(fileService.getFileContent).toHaveBeenCalledTimes(2);
    expect(setDimensions).toHaveBeenCalledTimes(2);
    expect(setDimensions).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }), 'a', {
      width: 1024,
      height: 768,
    });
  });

  it('probes a video via the stream path', async () => {
    const rows = [{ id: 'v1', key: 'key-v1', content_type: 'video/mp4' }];
    const { listener, fileService, mediaDimensionsService, setDimensions } = makeListener([rows, []]);
    mediaDimensionsService.fromVideoStream.mockResolvedValue({ width: 1920, height: 1080 });

    await listener.handleBatch({ userId: USER, limit: 10 });

    expect(fileService.getFileStream).toHaveBeenCalledTimes(1);
    expect(mediaDimensionsService.fromVideoStream).toHaveBeenCalledTimes(1);
    expect(setDimensions).toHaveBeenCalledWith(expect.anything(), 'v1', { width: 1920, height: 1080 });
  });

  it('skips (no write) a file whose dimensions cannot be read', async () => {
    const rows = [imageRow('a')];
    const { listener, setDimensions, mediaDimensionsService } = makeListener([rows, []]);
    mediaDimensionsService.fromImageBuffer.mockResolvedValue(null);

    await listener.handleBatch({ userId: USER, limit: 10 });

    expect(setDimensions).not.toHaveBeenCalled();
  });

  it('counts a probe error as failed without aborting the batch', async () => {
    const rows = [imageRow('a'), imageRow('b')];
    const { listener, setDimensions, fileService, mediaDimensionsService } = makeListener([rows, []]);
    mediaDimensionsService.fromImageBuffer.mockResolvedValue({ width: 10, height: 10 });
    fileService.getFileContent
      .mockRejectedValueOnce(new Error('s3 down'))
      .mockResolvedValueOnce(new Uint8Array([1]));

    await listener.handleBatch({ userId: USER, limit: 10 });

    // First row errors, second still recorded — batch isn't aborted.
    expect(setDimensions).toHaveBeenCalledTimes(1);
    expect(setDimensions).toHaveBeenCalledWith(expect.anything(), 'b', { width: 10, height: 10 });
  });

  it('stops at the requested limit and does not over-page', async () => {
    const page1 = [imageRow('a'), imageRow('b')];
    const { listener, builder, setDimensions, mediaDimensionsService } = makeListener([page1, []]);
    mediaDimensionsService.fromImageBuffer.mockResolvedValue({ width: 1, height: 1 });

    await listener.handleBatch({ userId: USER, limit: 2 });

    // Exactly one page fetched (limit reached); no second getRawMany call.
    expect(builder.qb.getRawMany).toHaveBeenCalledTimes(1);
    expect(setDimensions).toHaveBeenCalledTimes(2);
  });

  it('scopes candidates to ORIGINAL, locally-stored, dimensionless image/video files', async () => {
    const { listener, builder } = makeListener([[imageRow('a')], []]);

    await listener.handleBatch({ userId: USER, limit: 5 });

    const filter = builder.clauses.join(' ');
    expect(filter).toContain('file.userId = :userId');
    expect(filter).toContain('file.variant = :variant');
    expect(filter).toContain('file.key IS NOT NULL');
    expect(filter).toContain('file.width IS NULL');
    expect(filter).toContain("file.contentType LIKE 'image/%'");
    expect(filter).toContain("file.contentType LIKE 'video/%'");
  });
});
