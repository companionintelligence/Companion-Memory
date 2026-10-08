import { FacebookMediaService, facebookUrl, MAX_FACEBOOK_MEDIA_BYTES } from '../FacebookMediaService';

/**
 * Every dependency mocked, and the CDN hop (`cdnFetch`) replaced per test — the service's own
 * contract is what is under test: bytes go to FileService and the content row
 * points at the stored file; a failed download still leaves a row, pointing
 * at the CDN; an object already catalogued is updated, not duplicated.
 */
function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function build() {
  const contentService = {
    findBySource: jest.fn(async () => null),
    search: jest.fn(async () => []),
    create: jest.fn(async (_ctx: unknown, input: Record<string, unknown>) => [
      { id: 'content-new', ...input },
    ]),
    update: jest.fn(async () => ({ id: 'content-existing' })),
  };
  const fileService = {
    uploadWithDedupInfo: jest.fn(async () => ({ file: { id: 'file-1' }, deduped: false })),
  };
  const logger = makeLogger();
  const service = new FacebookMediaService(contentService as never, fileService as never, logger as never);

  return { service, contentService, fileService, logger };
}

function okResponse(bytes: number, headers: Record<string, string> = {}) {
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}

const photo = {
  kind: 'photo' as const,
  id: '2109746015919823',
  title: 'What happens when I just upload a photo?',
  pageUrl: 'https://www.facebook.com/photo.php?fbid=2109746015919823',
  cdnUrl: 'https://scontent-lax3-1.xx.fbcdn.net/v/t39.30808-6/x.jpg?oe=6A94EAE4',
  mimetype: 'image/jpeg',
  createdTime: '2018-02-08T01:32:20+0000',
};

describe('FacebookMediaService.upsertMedia', () => {
  it('downloads the CDN file, stores it, and writes a content row pointing at the stored file', async () => {
    const { service, contentService, fileService } = build();
    service.cdnFetch = jest.fn(async () => okResponse(1234, { 'content-length': '1234' }));

    const result = await service.upsertMedia({ userId: 'user-1', connectionId: 'conn-1', media: photo });

    expect(result).toEqual({ contentId: 'content-new', fileId: 'file-1' });
    expect(service.cdnFetch).toHaveBeenCalledWith(new URL(photo.cdnUrl), expect.anything());
    expect(fileService.uploadWithDedupInfo).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        filename: 'facebook-photo-2109746015919823.jpg',
        contentType: 'image/jpeg',
        size: 1234,
        skipDescription: true,
      }),
    );
    expect(contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        type: 'media',
        title: photo.title,
        mimetype: 'image/jpeg',
        // The stored file is the handle the drawer/gallery resolve to a
        // /static URL; the page link and CDN link are kept alongside.
        external_id: 'file-1',
        external_id_kind: 'file',
        url: photo.pageUrl,
        source_url: photo.cdnUrl,
        source_type: 'ETL',
        source_system: 'facebook',
        source_id: 'photo:2109746015919823',
        source_data: expect.objectContaining({
          contentType: 'facebook_photo',
          facebook_photo_id: '2109746015919823',
          connection_id: 'conn-1',
          file_id: 'file-1',
        }),
      }),
    );
  });

  it('still writes the row — as a source-native reference to the CDN link — when the download fails', async () => {
    const { service, contentService, fileService, logger } = build();
    service.cdnFetch = jest.fn(async () => new Response(null, { status: 403 }));

    const result = await service.upsertMedia({ userId: 'user-1', connectionId: 'conn-1', media: photo });

    expect(result).toEqual({ contentId: 'content-new', fileId: null });
    expect(fileService.uploadWithDedupInfo).not.toHaveBeenCalled();
    expect(contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        external_id: '2109746015919823',
        external_id_kind: 'external_uri',
        source_url: photo.cdnUrl,
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not store Facebook media; keeping the CDN link only',
      expect.anything(),
    );
  });

  it('refuses to buffer a file over the size cap and keeps the link instead', async () => {
    const { service, fileService } = build();
    service.cdnFetch = jest.fn(async () =>
      okResponse(10, { 'content-length': String(MAX_FACEBOOK_MEDIA_BYTES + 1) }),
    );

    const result = await service.upsertMedia({
      userId: 'user-1',
      connectionId: 'conn-1',
      media: { ...photo, kind: 'video', mimetype: 'video/mp4' },
    });

    expect(result.fileId).toBeNull();
    expect(fileService.uploadWithDedupInfo).not.toHaveBeenCalled();
  });

  it('updates the row an earlier run already keyed on the provenance triple, and does not re-download a stored file', async () => {
    const { service, contentService, fileService } = build();
    contentService.findBySource.mockResolvedValue({
      id: 'content-existing',
      externalId: 'file-old',
      externalIdKind: 'file',
      sourceData: { contentType: 'facebook_photo' },
    } as never);
    service.cdnFetch = jest.fn();

    const result = await service.upsertMedia({ userId: 'user-1', connectionId: 'conn-1', media: photo });

    expect(result).toEqual({ contentId: 'content-existing', fileId: 'file-old' });
    expect(service.cdnFetch).not.toHaveBeenCalled();
    expect(fileService.uploadWithDedupInfo).not.toHaveBeenCalled();
    expect(contentService.create).not.toHaveBeenCalled();
    expect(contentService.update).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'content-existing',
      expect.objectContaining({ external_id: 'file-old', external_id_kind: 'file' }),
    );
  });

  it('claims a row the pre-triple transform wrote (Graph id in external_id) instead of minting a second one', async () => {
    const { service, contentService } = build();
    // Legacy shape: external_id was the Facebook photo id, kind external_uri,
    // no provenance triple. A row for a DIFFERENT object type with the same
    // id must not be claimed.
    contentService.search.mockResolvedValue([
      {
        id: 'legacy-video',
        externalId: photo.id,
        externalIdKind: 'external_uri',
        sourceData: { contentType: 'facebook_video' },
      },
      {
        id: 'legacy-photo',
        externalId: photo.id,
        externalIdKind: 'external_uri',
        sourceData: { contentType: 'facebook_photo' },
      },
    ] as never);
    service.cdnFetch = jest.fn(async () => okResponse(50));

    const result = await service.upsertMedia({ userId: 'user-1', connectionId: 'conn-1', media: photo });

    expect(contentService.search).toHaveBeenCalledWith({ userId: 'user-1' }, { external_id: photo.id });
    expect(result).toEqual({ contentId: 'legacy-photo', fileId: 'file-1' });
    expect(contentService.create).not.toHaveBeenCalled();
    expect(contentService.update).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'legacy-photo',
      expect.objectContaining({
        external_id: 'file-1',
        external_id_kind: 'file',
        source_type: 'ETL',
        source_system: 'facebook',
        source_id: 'photo:2109746015919823',
      }),
    );
  });

  it.each([
    ['a link-local metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['plain http, even on the CDN', 'http://scontent-lax3-1.xx.fbcdn.net/v/x.jpg'],
    ['a host off the CDN', 'https://example.com/x.jpg'],
    ['a look-alike host', 'https://scontent.fbcdn.net.example.com/x.jpg'],
    ['a LAN address', 'https://192.168.1.10/x.jpg'],
  ])('never requests %s, and keeps only the link', async (_label, cdnUrl) => {
    // The URL comes out of a sync payload. Downloading it is what turned a forged payload into
    // a fetch of anything the appliance can reach, read back as the caller's own file.
    const { service, fileService, contentService } = build();
    service.cdnFetch = jest.fn(async () => okResponse(10));

    const result = await service.upsertMedia({
      userId: 'user-1',
      connectionId: 'conn-1',
      media: { ...photo, cdnUrl },
    });

    expect(service.cdnFetch).not.toHaveBeenCalled();
    expect(fileService.uploadWithDedupInfo).not.toHaveBeenCalled();
    expect(result.fileId).toBeNull();
    expect(contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ external_id_kind: 'external_uri' }),
    );
  });

  it('writes a link-only row when the object has no CDN URL at all', async () => {
    const { service, contentService } = build();
    service.cdnFetch = jest.fn();

    await service.upsertMedia({
      userId: 'user-1',
      connectionId: 'conn-1',
      media: { ...photo, cdnUrl: undefined },
    });

    expect(service.cdnFetch).not.toHaveBeenCalled();
    expect(contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        external_id: photo.id,
        external_id_kind: 'external_uri',
        source_url: undefined,
      }),
    );
  });
});

describe('facebookUrl', () => {
  it('makes the host-relative permalink Graph returns for videos absolute', () => {
    expect(facebookUrl('/4410495569178178/videos/2096266290601129')).toBe(
      'https://www.facebook.com/4410495569178178/videos/2096266290601129',
    );
  });

  it('leaves an absolute URL alone and passes empty through as undefined', () => {
    expect(facebookUrl('https://www.facebook.com/photo.php?fbid=1')).toBe(
      'https://www.facebook.com/photo.php?fbid=1',
    );
    expect(facebookUrl(undefined)).toBeUndefined();
    expect(facebookUrl('')).toBeUndefined();
  });
});
