import type { RequestContext } from '@ci/common/context';

import type { CommunicationType } from '../../types/CommunicationType';
import { CommunicationResolver } from '../CommunicationResolver';

/**
 * The read side of the message-attachment lane.
 *
 * `ci.communications.attachments` has existed since the table was created and
 * `CommunicationType` had no field over it, so even a correctly written column
 * would have shown a person nothing. The column stores a FLAT list of
 * `{ type, id }` references — every file ref, then every content ref — and the
 * two are handles on the same attachment, so the interesting behaviour here is
 * the pairing: a Messenger photo must be ONE entry, not two.
 */

const CTX = { userId: 'user-1' } as unknown as RequestContext;

const FILE_A = {
  filename: 'holiday.jpg',
  contentType: 'image/jpeg',
  url: '/files/a.jpg',
  previewUrl: '/files/a-thumb.jpg',
  width: 1600,
  height: 900,
  size: 204_800,
};

/** A reddit post's picture: a content row holding only the image URL and mimetype. */
const REDDIT_IMAGE = {
  id: 'content-reddit',
  url: 'https://i.redd.it/wu4xdo8if75h1.png',
  mimetype: 'image/png',
  externalId: null,
  externalIdKind: null,
  sourceUrl: null,
  title: "That's a lotta shells!",
};

/** A content row whose bytes live in ci.files (a Messenger photo's content half). */
const STORED_CONTENT = {
  id: 'content-stored',
  url: null,
  mimetype: null,
  externalId: 'file-stored',
  externalIdKind: 'file',
  sourceUrl: null,
  title: null,
};

const STORED_FILE = {
  previewUrl: '/files/stored-thumb.jpg',
  mediaUrl: '/files/stored.jpg',
  contentType: 'image/jpeg',
  filename: 'stored.jpg',
  size: 1_024,
};

function makeResolver({
  files = { 'file-a': FILE_A },
  contents = { 'content-reddit': REDDIT_IMAGE, 'content-stored': STORED_CONTENT },
  contentFiles = { 'file-stored': STORED_FILE },
}: {
  files?: Record<string, unknown>;
  contents?: Record<string, unknown>;
  contentFiles?: Record<string, unknown>;
} = {}) {
  const byId = (table: Record<string, unknown>) =>
    jest.fn(async (_ctx: unknown, ids: readonly string[]) => ids.map((id) => table[id] ?? null));
  const loadMany = byId(files);
  const loadContents = byId(contents);
  const loadContentFiles = byId(contentFiles);
  const resolver = new CommunicationResolver(
    {} as never,
    { loadMany } as never,
    { loadMany: loadContents } as never,
    { loadMany: loadContentFiles } as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
  );

  return { resolver, loadMany, loadContents, loadContentFiles };
}

function message(attachments: unknown[]): CommunicationType {
  return { __source: { id: 'comm-1', attachments } } as unknown as CommunicationType;
}

describe('CommunicationResolver attachments', () => {
  it('resolves a file reference to displayable media', async () => {
    const { resolver } = makeResolver();

    await expect(resolver.attachments(CTX, message([{ type: 'file', id: 'file-a' }]))).resolves.toEqual([
      {
        fileId: 'file-a',
        contentId: null,
        filename: 'holiday.jpg',
        contentType: 'image/jpeg',
        url: '/files/a.jpg',
        previewUrl: '/files/a-thumb.jpg',
        width: 1600,
        height: 900,
        size: 204_800,
      },
    ]);
  });

  it('pairs a file and its content row into ONE attachment', async () => {
    // A gallery over the raw column would draw this photo twice.
    const { resolver } = makeResolver();
    const attachments = await resolver.attachments(
      CTX,
      message([
        { type: 'file', id: 'file-a' },
        { type: 'content', id: 'content-a' },
      ]),
    );

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ fileId: 'file-a', contentId: 'content-a' });
  });

  it('keeps the pairing index-aligned across several attachments', async () => {
    const { resolver } = makeResolver({
      files: { 'file-a': FILE_A, 'file-b': { ...FILE_A, filename: 'b.mp4' } },
    });
    const attachments = await resolver.attachments(
      CTX,
      message([
        { type: 'file', id: 'file-a' },
        { type: 'file', id: 'file-b' },
        { type: 'content', id: 'content-a' },
        { type: 'content', id: 'content-b' },
      ]),
    );

    // Not [a,a],[b,b] by accident of ordering: the writer stamps both arrays
    // from one descriptor list, so attachment i pairs files[i] with contents[i].
    expect(attachments.map((a) => [a.fileId, a.contentId])).toEqual([
      ['file-a', 'content-a'],
      ['file-b', 'content-b'],
    ]);
  });

  it('still shows an attachment whose file is gone', async () => {
    // Purged bytes, or a file the user deleted. The reference is real; only the
    // media is missing, and a silently shorter list would hide that.
    const { resolver } = makeResolver({ files: {} });

    await expect(resolver.attachments(CTX, message([{ type: 'file', id: 'file-x' }]))).resolves.toEqual([
      expect.objectContaining({ fileId: 'file-x', url: null, previewUrl: null }),
    ]);
  });

  it('survives a reference shape nobody wrote', async () => {
    // A jsonb column with no constraint behind it, previously written by
    // nothing at all — a junk entry must not throw on a message list.
    const { resolver } = makeResolver();

    await expect(
      resolver.attachments(CTX, message([null, 'nope', { type: 'file' }, { type: 'file', id: 'file-a' }])),
    ).resolves.toHaveLength(1);
  });

  it('is empty for a message with no attachments', async () => {
    const { resolver, loadMany } = makeResolver();

    await expect(resolver.attachments(CTX, message([]))).resolves.toEqual([]);
    // The default every communication in the corpus sits at — and it must not
    // cost a query.
    expect(loadMany).not.toHaveBeenCalled();
  });

  it('scopes the file lookup to the requesting user', async () => {
    const { resolver, loadMany } = makeResolver();

    await resolver.attachments(CTX, message([{ type: 'file', id: 'file-a' }]));

    expect(loadMany).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), ['file-a']);
  });

  describe('content-only references', () => {
    // How a reddit post carries its picture: the importer attaches a content
    // row with the image URL and mimetype and stores no file. This used to
    // come back as a bare contentId, which the drawer could neither render
    // nor list — the picture vanished.
    it('renders a content row that only knows a URL, named after the URL', async () => {
      const { resolver, loadContentFiles } = makeResolver();

      await expect(
        resolver.attachments(CTX, message([{ type: 'content', id: 'content-reddit' }])),
      ).resolves.toEqual([
        {
          fileId: null,
          contentId: 'content-reddit',
          filename: 'wu4xdo8if75h1.png',
          contentType: 'image/png',
          url: 'https://i.redd.it/wu4xdo8if75h1.png',
          previewUrl: null,
          width: null,
          height: null,
          size: null,
        },
      ]);
      // No file hop for a row that points at no file.
      expect(loadContentFiles).not.toHaveBeenCalled();
    });

    it('walks a content row that points at a stored file through to that file', async () => {
      const { resolver, loadContentFiles } = makeResolver();

      await expect(
        resolver.attachments(CTX, message([{ type: 'content', id: 'content-stored' }])),
      ).resolves.toEqual([
        expect.objectContaining({
          contentId: 'content-stored',
          filename: 'stored.jpg',
          contentType: 'image/jpeg',
          url: '/files/stored.jpg',
          previewUrl: '/files/stored-thumb.jpg',
          size: 1_024,
        }),
      ]);
      expect(loadContentFiles).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }), [
        'file-stored',
      ]);
    });

    it('prefers the file half of a paired attachment over its content row', async () => {
      const { resolver } = makeResolver();
      const [attachment] = await resolver.attachments(
        CTX,
        message([
          { type: 'file', id: 'file-a' },
          { type: 'content', id: 'content-reddit' },
        ]),
      );

      // The stored file has dimensions, a preview and a real filename; the
      // content row's URL is only the fallback for when there is no file.
      expect(attachment).toMatchObject({
        fileId: 'file-a',
        contentId: 'content-reddit',
        url: '/files/a.jpg',
      });
    });

    it('still shows a content reference whose row is gone', async () => {
      const { resolver } = makeResolver({ contents: {} });

      await expect(
        resolver.attachments(CTX, message([{ type: 'content', id: 'content-x' }])),
      ).resolves.toEqual([expect.objectContaining({ contentId: 'content-x', url: null, filename: null })]);
    });

    it('does not look up content rows for a message with only file references', async () => {
      const { resolver, loadContents } = makeResolver();

      await resolver.attachments(CTX, message([{ type: 'file', id: 'file-a' }]));

      expect(loadContents).not.toHaveBeenCalled();
    });
  });
});
