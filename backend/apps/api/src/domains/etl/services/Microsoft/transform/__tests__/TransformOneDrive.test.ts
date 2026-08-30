import { OneDriveTransformService } from '../TransformOneDrive';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function build() {
  const contentService = {
    create: jest.fn(async () => [{ id: 'content-1' }]),
    findBySource: jest.fn(async () => null as { id: string } | null),
  };
  const fileService = { create: jest.fn(async () => ({ id: 'file-1' })) };

  const service = new OneDriveTransformService(
    contentService as never,
    fileService as never,
    {} as never, // ConnectionService — unused by processOneDriveItem
    makeLogger() as never,
  );

  return { service, contentService, fileService };
}

const connection = { id: 'conn-1' } as never;

function syncJobWithItem(item: Record<string, unknown>) {
  return { id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data: { files: [item] } } as never;
}

function docItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    name: 'report.pdf',
    file: { mimeType: 'application/pdf' },
    webUrl: 'https://onedrive.live.com/item-1',
    lastModifiedDateTime: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

describe('OneDriveTransformService.transformOneDrive', () => {
  it('stamps the provenance triple on the document content row so a re-sync dedupes', async () => {
    const { service, contentService } = build();

    await service.transformOneDrive({ connection, syncJob: syncJobWithItem(docItem()) });

    expect(contentService.findBySource).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { source_type: 'ETL', source_system: 'onedrive', source_id: 'item-1' },
    );
    expect(contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        source_type: 'ETL',
        source_system: 'onedrive',
        source_id: 'item-1',
      }),
    );
  });

  it('skips the content row when the triple already resolves to one', async () => {
    const { service, contentService, fileService } = build();
    contentService.findBySource.mockResolvedValue({ id: 'content-9' });

    await service.transformOneDrive({ connection, syncJob: syncJobWithItem(docItem()) });

    expect(contentService.create).not.toHaveBeenCalled();
    // The pointer row still goes through FileService, which dedupes internally.
    expect(fileService.create).toHaveBeenCalledTimes(1);
  });

  it('keys the ci.files pointer on the Graph item id when webUrl is missing', async () => {
    const { service, fileService } = build();

    await service.transformOneDrive({
      connection,
      syncJob: syncJobWithItem(docItem({ webUrl: undefined })),
    });

    expect(fileService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ externalId: 'item-1' }),
    );
  });

  it('does not write a content row for a non-document type', async () => {
    const { service, contentService, fileService } = build();

    await service.transformOneDrive({
      connection,
      syncJob: syncJobWithItem(docItem({ file: { mimeType: 'image/jpeg' } })),
    });

    expect(contentService.create).not.toHaveBeenCalled();
    expect(fileService.create).toHaveBeenCalledTimes(1);
  });
});
