import { PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import { STAGE_VERSIONS } from '../../versions';
import { FILE_PREVIEW_SOURCE, FilePreviewStage } from '../enrich/FilePreviewStage';

/**
 * The stage is a thin ledger adapter over FilePreviewService, so what is
 * tested is the adapter's contract: which service outcomes become which
 * ledger outcomes, that IO failures are the only `failed`, and that the
 * source predicate offers exactly the preview-less originals.
 */
function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function build() {
  const filePreviewService = { generate: jest.fn() };
  const stage = new FilePreviewStage(filePreviewService as never, makeLogger() as never);

  return { stage, filePreviewService };
}

const ctx = { userId: 'user-1' } as never;

describe('FilePreviewStage — declaration', () => {
  it('is wired: registered id, declared version, enrich queue, file entity', () => {
    const { stage } = build();

    expect(stage.id).toBe(STAGE_IDS.ENRICH_FILE_PREVIEW);
    expect(stage.version).toBe(STAGE_VERSIONS[STAGE_IDS.ENRICH_FILE_PREVIEW]);
    expect(stage.queue).toBe(PIPELINE_QUEUES.ENRICH);
    expect(stage.entityTypes).toEqual(['file']);
  });

  it('offers only live, stored, image/video ORIGINALs that have no PREVIEW yet', () => {
    expect(FILE_PREVIEW_SOURCE).toMatchObject({
      schema: 'ci',
      table: 'files',
      idColumn: 'id',
      userColumn: 'user_id',
    });
    expect(FILE_PREVIEW_SOURCE.predicate).toContain("s.variant = 'ORIGINAL'");
    expect(FILE_PREVIEW_SOURCE.predicate).toContain('s.deleted_at IS NULL');
    expect(FILE_PREVIEW_SOURCE.predicate).toContain('s.key IS NOT NULL');
    expect(FILE_PREVIEW_SOURCE.predicate).toContain("s.content_type LIKE 'image/%'");
    expect(FILE_PREVIEW_SOURCE.predicate).toContain("s.content_type LIKE 'video/%'");
    expect(FILE_PREVIEW_SOURCE.predicate).toContain("v.parent_id = s.id AND v.variant = 'PREVIEW'");
  });
});

describe('FilePreviewStage.run', () => {
  it('maps generated → done, exists → done, skipped → skipped with the service’s reason', async () => {
    const { stage, filePreviewService } = build();
    filePreviewService.generate
      .mockResolvedValueOnce({ outcome: 'generated', previewId: 'p1' })
      .mockResolvedValueOnce({ outcome: 'exists', previewId: 'p2' })
      .mockResolvedValueOnce({ outcome: 'skipped', reason: 'undecodable' });

    const results = await stage.run(ctx, ['f1', 'f2', 'f3']);

    expect(results.get('f1')).toEqual({ outcome: 'done', detail: { previewId: 'p1' } });
    expect(results.get('f2')).toEqual({
      outcome: 'done',
      reason: 'preview_exists',
      detail: { previewId: 'p2' },
    });
    expect(results.get('f3')).toEqual({ outcome: 'skipped', reason: 'undecodable' });
    expect(filePreviewService.generate).toHaveBeenCalledWith(ctx, { fileId: 'f1' });
  });

  it('records an IO throw as a retryable failure without failing the slice', async () => {
    const { stage, filePreviewService } = build();
    filePreviewService.generate
      .mockRejectedValueOnce(new Error('S3 object body was empty'))
      .mockResolvedValueOnce({ outcome: 'generated', previewId: 'p2' });

    const results = await stage.run(ctx, ['f1', 'f2']);

    expect(results.get('f1')).toEqual({
      outcome: 'failed',
      reason: 'object_storage_read_failed',
      detail: { message: 'S3 object body was empty' },
    });
    expect(results.get('f2')?.outcome).toBe('done');
  });

  it('returns an empty map for an empty slice without touching the service', async () => {
    const { stage, filePreviewService } = build();

    expect((await stage.run(ctx, [])).size).toBe(0);
    expect(filePreviewService.generate).not.toHaveBeenCalled();
  });
});
