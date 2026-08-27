import { FacebookPostsTransformService, postMedia } from '../transform/TransformFacebookPosts';

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function build() {
  const communicationService = {
    findBySource: jest.fn(async () => null),
    create: jest.fn(async () => ({ id: 'comm-1' })),
    update: jest.fn(async () => ({ id: 'comm-1' })),
  };
  const contentService = {
    search: jest.fn(async () => []),
    remove: jest.fn(async () => true),
  };
  const facebookMediaService = {
    upsertMedia: jest.fn(
      async ({
        media,
      }: {
        media: { id: string };
      }): Promise<{ contentId: string; fileId: string | null }> => ({
        contentId: `content-${media.id}`,
        fileId: `file-${media.id}`,
      }),
    ),
  };

  const service = new FacebookPostsTransformService(
    communicationService as never,
    contentService as never,
    facebookMediaService as never,
    makeLogger() as never,
  );

  return { service, communicationService, contentService, facebookMediaService };
}

const connection = { id: 'conn-1' } as never;

function syncJobWith(posts: unknown[]) {
  return { id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data: { posts } } as never;
}

const textPost = {
  id: '4410495569178178_2195886703972420',
  message: 'Check this feed out.',
  created_time: '2018-07-06T22:10:59+0000',
  link: 'https://app.lifescope.io/shared?id=0238bb2b',
  type: 'link',
  permalink_url: 'https://www.facebook.com/4410495569178178/posts/2195886703972420',
  from: { id: '4410495569178178', name: 'Kyle Baran' },
};

describe('FacebookPostsTransformService.transform', () => {
  it('writes a post as an outbound Communication of type post, keyed on its provenance triple', async () => {
    const { service, communicationService } = build();

    await service.transform({ connection, syncJob: syncJobWith([textPost]) });

    expect(communicationService.create).toHaveBeenCalledTimes(1);
    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        communication_type: 'post',
        direction: 'outbound',
        time: new Date('2018-07-06T22:10:59+0000'),
        content: 'Check this feed out.',
        connection_id: 'conn-1',
        source_type: 'ETL',
        source_system: 'facebook',
        source_id: 'post:4410495569178178_2195886703972420',
        participants_metadata: { facebook_user_id: '4410495569178178', facebook_user_name: 'Kyle Baran' },
        metadata: expect.objectContaining({
          facebook_post_id: '4410495569178178_2195886703972420',
          permalink_url: 'https://www.facebook.com/4410495569178178/posts/2195886703972420',
          link: 'https://app.lifescope.io/shared?id=0238bb2b',
        }),
        attachments: [],
      }),
    );
  });

  it('derives the post permalink from its Graph id when the sync payload carries none', async () => {
    const { service, communicationService } = build();
    const { permalink_url: _omitted, ...withoutPermalink } = textPost;

    await service.transform({ connection, syncJob: syncJobWith([withoutPermalink]) });

    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        metadata: expect.objectContaining({
          permalink_url: 'https://www.facebook.com/4410495569178178/posts/2195886703972420',
          // The shared URL stays what it was — it is not the post.
          link: 'https://app.lifescope.io/shared?id=0238bb2b',
        }),
      }),
    );
  });

  it('catalogues the post’s photos/videos as Content via FacebookMediaService and links them from attachments', async () => {
    const { service, communicationService, facebookMediaService } = build();
    const post = {
      id: 'p1',
      message: 'Music generated with MIDI Sprout',
      created_time: '2018-01-12T20:47:11+0000',
      attachments: {
        data: [
          {
            type: 'video_inline',
            media_type: 'video',
            target: { id: 'v1', url: 'https://www.facebook.com/4410495569178178/videos/v1' },
            media: {
              image: { src: 'https://cdn/thumb.jpg', width: 720, height: 405 },
              source: 'https://cdn/v1.mp4',
            },
          },
          {
            type: 'album',
            media_type: 'album',
            subattachments: {
              data: [
                {
                  type: 'photo',
                  media_type: 'photo',
                  target: { id: 'ph1', url: 'https://www.facebook.com/photo/ph1' },
                  media: { image: { src: 'https://cdn/ph1.jpg', width: 1, height: 1 } },
                },
                {
                  type: 'photo',
                  media_type: 'photo',
                  target: { id: 'ph2', url: 'https://www.facebook.com/photo/ph2' },
                  media: { image: { src: 'https://cdn/ph2.jpg', width: 1, height: 1 } },
                },
              ],
            },
          },
          {
            type: 'share',
            media_type: 'link',
            url: 'https://example.com',
            media: { image: { src: 'https://cdn/preview.jpg', width: 1, height: 1 } },
          },
        ],
      },
    };

    await service.transform({ connection, syncJob: syncJobWith([post]) });

    // Three media objects; the link-preview share is not media.
    expect(facebookMediaService.upsertMedia).toHaveBeenCalledTimes(3);
    expect(facebookMediaService.upsertMedia).toHaveBeenNthCalledWith(1, {
      userId: 'user-1',
      connectionId: 'conn-1',
      media: expect.objectContaining({
        kind: 'video',
        id: 'v1',
        cdnUrl: 'https://cdn/v1.mp4',
        mimetype: 'video/mp4',
      }),
    });
    expect(facebookMediaService.upsertMedia).toHaveBeenNthCalledWith(2, {
      userId: 'user-1',
      connectionId: 'conn-1',
      media: expect.objectContaining({ kind: 'photo', id: 'ph1', cdnUrl: 'https://cdn/ph1.jpg' }),
    });

    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        attachments: [
          { type: 'file', id: 'file-v1' },
          { type: 'content', id: 'content-v1' },
          { type: 'file', id: 'file-ph1' },
          { type: 'content', id: 'content-ph1' },
          { type: 'file', id: 'file-ph2' },
          { type: 'content', id: 'content-ph2' },
        ],
      }),
    );
  });

  it('links only the content row when the media bytes could not be stored', async () => {
    const { service, communicationService, facebookMediaService } = build();
    facebookMediaService.upsertMedia.mockResolvedValue({ contentId: 'content-x', fileId: null });

    await service.transform({
      connection,
      syncJob: syncJobWith([
        {
          id: 'p1',
          created_time: '2018-01-12T20:47:11+0000',
          attachments: {
            data: [{ type: 'photo', target: { id: 'x' }, media: { image: { src: 'https://cdn/x.jpg' } } }],
          },
        },
      ]),
    });

    expect(communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ attachments: [{ type: 'content', id: 'content-x' }] }),
    );
  });

  it('updates the existing communication on a re-sync instead of creating a second one', async () => {
    const { service, communicationService } = build();
    communicationService.findBySource.mockResolvedValue({ id: 'comm-existing' } as never);

    await service.transform({ connection, syncJob: syncJobWith([textPost]) });

    expect(communicationService.findBySource).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { source_type: 'ETL', source_system: 'facebook', source_id: 'post:4410495569178178_2195886703972420' },
    );
    expect(communicationService.create).not.toHaveBeenCalled();
    expect(communicationService.update).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'comm-existing',
      expect.objectContaining({
        content: 'Check this feed out.',
        attachments: [],
        // A re-sync refreshes the metadata too — the permalink a later fetch
        // added must reach rows written before it was requested.
        metadata: expect.objectContaining({
          permalink_url: 'https://www.facebook.com/4410495569178178/posts/2195886703972420',
        }),
      }),
    );
  });

  it('removes the Content rows the old transforms wrote for the post (as a post, and as a mislabelled like)', async () => {
    const { service, contentService } = build();
    contentService.search.mockResolvedValue([
      { id: 'old-post', sourceData: { contentType: 'facebook_post' } },
      { id: 'old-like', sourceData: { contentType: 'facebook_like' } },
      // A real photo that happens to share nothing but the lookup is untouched.
      { id: 'unrelated', sourceData: { contentType: 'facebook_photo' } },
    ] as never);

    await service.transform({ connection, syncJob: syncJobWith([textPost]) });

    expect(contentService.search).toHaveBeenCalledWith({ userId: 'user-1' }, { external_id: textPost.id });
    expect(contentService.remove).toHaveBeenCalledTimes(2);
    expect(contentService.remove).toHaveBeenCalledWith({ userId: 'user-1' }, 'old-post');
    expect(contentService.remove).toHaveBeenCalledWith({ userId: 'user-1' }, 'old-like');
  });

  it('falls back to the story, then the link, for a post with no message text', async () => {
    const { service, communicationService } = build();

    await service.transform({
      connection,
      syncJob: syncJobWith([
        { id: 'p1', created_time: '2018-01-12T20:47:11+0000', story: 'Kyle shared a link.' },
        { id: 'p2', created_time: '2018-01-12T20:47:11+0000', link: 'https://example.com' },
      ]),
    });

    expect(communicationService.create).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ content: 'Kyle shared a link.' }),
    );
    expect(communicationService.create).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ content: 'https://example.com' }),
    );
  });

  it('keeps going past one post that fails', async () => {
    const { service, communicationService } = build();
    communicationService.create.mockRejectedValueOnce(new Error('boom'));

    await service.transform({
      connection,
      syncJob: syncJobWith([textPost, { ...textPost, id: 'second' }]),
    });

    expect(communicationService.create).toHaveBeenCalledTimes(2);
  });
});

describe('postMedia', () => {
  it('gives an attachment without a target id a stable synthetic id off the post (older sync payloads)', () => {
    const refs = postMedia({
      id: 'p9',
      created_time: '2018-01-12T20:47:11+0000',
      attachments: { data: [{ media: { image: { src: 'https://cdn/a.jpg', width: 1, height: 1 } } }] },
    });

    expect(refs).toEqual([
      expect.objectContaining({ kind: 'photo', id: 'p9:attachment:0', cdnUrl: 'https://cdn/a.jpg' }),
    ]);
  });

  it('ignores a share attachment even though it carries a preview image', () => {
    expect(
      postMedia({
        id: 'p1',
        created_time: '2018-01-12T20:47:11+0000',
        attachments: {
          data: [
            { type: 'share', media: { image: { src: 'https://cdn/preview.jpg', width: 1, height: 1 } } },
          ],
        },
      }),
    ).toEqual([]);
  });
});
