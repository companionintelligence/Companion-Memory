import type { RequestContext } from '@ci/common/context';

import { ContentType } from '../../types/ContentType';
import { ContentResolver } from '../ContentResolver';

/**
 * The media fields on ContentType exist because a media content row carries no
 * `url`/`sourceUrl` of its own — the binary hangs off `external_id -> ci.files`.
 * What matters here is the gate: `external_id` is structurally overloaded, so
 * only rows that genuinely reference a file may take the file hop.
 */
const FILE_ID = '019ee82a-2f70-71fd-b4a7-2679a8e5140b';

const CTX = { user: { id: 'user-1' } } as unknown as RequestContext;

const media = {
  previewUrl: '/files/thumb.jpg',
  mediaUrl: '/files/original.jpg',
  contentType: 'image/jpeg',
  filename: 'original.jpg',
  size: 2048,
};

function makeResolver() {
  const load = jest.fn(async () => media);
  const resolver = new ContentResolver(
    {} as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
    { load } as never,
    { load: jest.fn() } as never,
  );

  return { resolver, load };
}

/** A ContentType node as SearchResolver hands it to the field resolvers. */
function node(source: Partial<ContentType['__source']>): ContentType {
  return { __source: { userId: 'user-1', ...source } } as unknown as ContentType;
}

describe('ContentResolver media fields', () => {
  it('resolves preview, media URL and size for an external_id_kind = file row', async () => {
    const { resolver } = makeResolver();
    const parent = node({ externalId: FILE_ID, externalIdKind: 'file' });

    await expect(resolver.previewUrl(CTX, parent)).resolves.toBe('/files/thumb.jpg');
    await expect(resolver.mediaUrl(CTX, parent)).resolves.toBe('/files/original.jpg');
    await expect(resolver.mediaSize(CTX, parent)).resolves.toBe(2048);
    await expect(resolver.mediaFilename(CTX, parent)).resolves.toBe('original.jpg');
  });

  it('scopes the file lookup to the content row owner', async () => {
    const { resolver, load } = makeResolver();

    await resolver.previewUrl(CTX, node({ externalId: FILE_ID, externalIdKind: 'file', userId: 'owner-9' }));

    expect(load).toHaveBeenCalledWith({ userId: 'owner-9' }, FILE_ID);
  });

  // spotify:track:… and friends never resolve against ci.files; taking the hop
  // for them would be a wasted query per row at best and a wrong join at worst.
  it('never takes the file hop for a source-native external_uri', async () => {
    const { resolver, load } = makeResolver();
    const parent = node({ externalId: 'spotify:track:abc', externalIdKind: 'external_uri' });

    await expect(resolver.previewUrl(CTX, parent)).resolves.toBeNull();
    await expect(resolver.mediaUrl(CTX, parent)).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  // Rows written before migration 20260818215331 carry a NULL kind; they are
  // re-tested by shape rather than assumed to be file ids.
  it('classifies an unclassified external_id by shape', async () => {
    const { resolver, load } = makeResolver();

    await expect(resolver.previewUrl(CTX, node({ externalId: FILE_ID, externalIdKind: null }))).resolves.toBe(
      '/files/thumb.jpg',
    );
    expect(load).toHaveBeenCalledTimes(1);

    // A bare platform id is neither shape — left unclassified, so no hop.
    await expect(
      resolver.previewUrl(CTX, node({ externalId: 'dQw4w9WgXcQ', externalIdKind: null })),
    ).resolves.toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('resolves to null for a content row with no external_id at all', async () => {
    const { resolver, load } = makeResolver();

    await expect(
      resolver.mediaUrl(CTX, node({ externalId: null, externalIdKind: null })),
    ).resolves.toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it('resolves mediaFilename to null when the row has no linked file', async () => {
    const { resolver } = makeResolver();

    await expect(
      resolver.mediaFilename(CTX, node({ externalId: null, externalIdKind: null })),
    ).resolves.toBeNull();
  });
});

describe('ContentType.toType provenance', () => {
  it('copies sourceType, sourceSystem, sourceId and createdAt from the entity', () => {
    const createdAt = new Date('2026-08-26T12:00:00.000Z');
    const type = ContentType.toType({
      id: 'c1',
      type: 'document',
      title: 'invoice.pdf',
      text: null,
      url: null,
      mimetype: 'application/pdf',
      externalId: FILE_ID,
      sourceUrl: 'https://mail.google.com/mail/u/0/#inbox',
      sourceType: 'email',
      sourceSystem: 'gmail',
      sourceId: 'msg-1',
      createdAt,
      sourceData: null,
    } as never);

    expect(type.sourceType).toBe('email');
    expect(type.sourceSystem).toBe('gmail');
    expect(type.sourceId).toBe('msg-1');
    expect(type.createdAt).toBe(createdAt);
  });
});
