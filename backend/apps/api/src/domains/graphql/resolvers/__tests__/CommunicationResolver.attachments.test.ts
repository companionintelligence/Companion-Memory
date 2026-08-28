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

function makeResolver(files: Record<string, unknown> = { 'file-a': FILE_A }) {
  const loadMany = jest.fn(async (_ctx: unknown, ids: readonly string[]) =>
    ids.map((id) => files[id] ?? null),
  );
  const resolver = new CommunicationResolver(
    {} as never,
    { loadMany } as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
  );

  return { resolver, loadMany };
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
    const { resolver } = makeResolver({ 'file-a': FILE_A, 'file-b': { ...FILE_A, filename: 'b.mp4' } });
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
    const { resolver } = makeResolver({});

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
});
