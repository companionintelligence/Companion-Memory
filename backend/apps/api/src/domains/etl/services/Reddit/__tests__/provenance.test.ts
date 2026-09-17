import { redditIdentity } from '@ci/domains/memory';

import { RedditRecordWriter, commentRecord, postRecord, savedRecord } from '../transform/RedditRecordWriter';
import { RedditCommentsTransformService } from '../transform/TransformComments';
import { RedditPostsTransformService } from '../transform/TransformPosts';
import { RedditSavedTransformService } from '../transform/TransformSaved';

/**
 * The Reddit connection writes what the GDPR-export importer writes: a dated
 * post or comment is a communication (content only rides along for media),
 * an undated one is content alone, and the key is the importer's
 * `reddit:<kind>:<bare id>` so the two arrivals dedupe onto one row.
 */

/** The DTO a mocked service method was called with (its second argument, after the context). */
function rowOf(mock: jest.Mock, call = 0): Record<string, unknown> {
  return (mock.mock.calls[call] as unknown[])[1] as Record<string, unknown>;
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
}

function makeDeps() {
  return {
    communicationService: {
      findBySource: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'comm-1' })),
      update: jest.fn(async () => ({ id: 'comm-1' })),
      recordArrival: jest.fn(async () => undefined),
      remove: jest.fn(async () => true),
    },
    contentService: {
      search: jest.fn(async () => []),
      create: jest.fn(async () => [{ id: 'content-1' }]),
      remove: jest.fn(async () => true),
    },
    eventService: {
      search: jest.fn(async () => []),
      remove: jest.fn(async () => true),
    },
  };
}

function makeWriter(deps = makeDeps()) {
  return {
    deps,
    writer: new RedditRecordWriter(
      deps.communicationService as never,
      deps.contentService as never,
      deps.eventService as never,
      makeLogger() as never,
    ),
  };
}

const connection = { id: 'conn-1' } as never;
const ctx = { userId: 'user-1', connection };

function syncJob(data: Record<string, unknown>) {
  return { id: 'job-1', userId: 'user-1', connectionId: 'conn-1', data } as never;
}

const post = {
  id: 'abc',
  name: 't3_abc',
  permalink: '/r/test/comments/abc/hello/',
  title: 'Hello',
  selftext: 'Body',
  subreddit: 'test',
  author: 'me',
  score: 1,
  num_comments: 0,
  is_self: true,
  created_utc: 1700000000,
  url: 'https://www.reddit.com/r/test/comments/abc/hello/',
};

const comment = {
  id: 'def',
  name: 't1_def',
  permalink: '/r/test/comments/abc/hello/def/',
  body: 'A comment',
  subreddit: 'test',
  author: 'me',
  link_title: 'Hello',
  score: 1,
  created_utc: 1700000000,
};

describe('RedditRecordWriter', () => {
  it("writes the user's post as an outbound communication keyed like the importer, and no content/event", async () => {
    const { writer, deps } = makeWriter();

    await expect(writer.write(ctx, postRecord(post))).resolves.toBe('created');

    expect(deps.communicationService.create).toHaveBeenCalledTimes(1);
    const row = rowOf(deps.communicationService.create);
    expect(row).toMatchObject({
      communication_type: 'post',
      direction: 'outbound',
      thread_id: 'r/test',
      subject: 'Hello',
      content: 'Body',
      connection_id: 'conn-1',
      source_type: 'ETL',
      source_system: 'reddit',
      source_id: 'reddit:post:abc',
      attachments: [],
    });
    expect(row.time).toEqual(new Date(1700000000 * 1000));
    expect(row.source_id).toBe(redditIdentity('post', 't3_abc').id);
    expect(deps.contentService.create).not.toHaveBeenCalled();
  });

  it('a comment is an outbound communication with no subject, keyed reddit:comment:<id>', async () => {
    const { writer, deps } = makeWriter();

    await writer.write(ctx, commentRecord(comment));

    expect(deps.communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        direction: 'outbound',
        content: 'A comment',
        thread_id: 'r/test',
        source_system: 'reddit',
        source_id: 'reddit:comment:def',
      }),
    );
    expect(rowOf(deps.communicationService.create).subject).toBeUndefined();
    expect(deps.contentService.create).not.toHaveBeenCalled();
  });

  it('a link post pointing at an image adds ONE media content row, linked as an attachment', async () => {
    const { writer, deps } = makeWriter();

    await writer.write(
      ctx,
      postRecord({ ...post, is_self: false, selftext: '', url: 'https://i.redd.it/abc123.jpg' }),
    );

    expect(deps.contentService.create).toHaveBeenCalledTimes(1);
    expect(deps.contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        type: 'image',
        url: 'https://i.redd.it/abc123.jpg',
        mimetype: 'image/jpeg',
        title: 'Hello',
        text: 'Hello',
        source_system: 'reddit',
        source_id: 'reddit:post:abc',
      }),
    );
    expect(deps.communicationService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ attachments: [{ type: 'content', id: 'content-1' }] }),
    );
  });

  it("a comment's media is the first image/video link in its body, and its content row has no title", async () => {
    const { writer, deps } = makeWriter();

    await writer.write(
      ctx,
      commentRecord({ ...comment, body: 'look https://imgur.com/page and https://v.redd.it/xyz then text' }),
    );

    const row = rowOf(deps.contentService.create);
    expect(row).toMatchObject({
      type: 'video',
      url: 'https://v.redd.it/xyz',
      source_id: 'reddit:comment:def',
    });
    expect(row.title).toBeUndefined();
  });

  it('an undated record goes to content alone (communications.time is NOT NULL)', async () => {
    const { writer, deps } = makeWriter();

    await expect(writer.write(ctx, postRecord({ ...post, created_utc: undefined as never }))).resolves.toBe(
      'content_only',
    );

    expect(deps.communicationService.create).not.toHaveBeenCalled();
    expect(deps.contentService.create).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({
        type: 'social',
        title: 'Hello',
        url: 'https://www.reddit.com/r/test/comments/abc/hello/',
        source_system: 'reddit',
        source_id: 'reddit:post:abc',
      }),
    );
  });

  it("refreshes a row that already exists — the importer's copy included — instead of inserting", async () => {
    const deps = makeDeps();
    deps.communicationService.findBySource.mockResolvedValue({
      id: 'comm-existing',
      metadata: { Kind: 'post', IP: '1.2.3.4' },
      attachments: [],
    } as never);
    const { writer } = makeWriter(deps);

    await expect(writer.write(ctx, postRecord({ ...post, score: 42 }))).resolves.toBe('updated');

    expect(deps.communicationService.create).not.toHaveBeenCalled();
    // The dedup hit is ledgered as an ETL arrival on the existing row.
    expect(deps.communicationService.recordArrival).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'comm-existing',
      expect.objectContaining({ source_type: 'ETL', source_id: 'reddit:post:abc', connection_id: 'conn-1' }),
    );
    expect(deps.communicationService.update).toHaveBeenCalledWith(
      { userId: 'user-1' },
      'comm-existing',
      expect.objectContaining({
        content: 'Body',
        metadata: expect.objectContaining({
          Kind: 'post',
          IP: '1.2.3.4',
          score: 42,
          reddit_fullname: 't3_abc',
        }),
      }),
    );
  });

  it('removes the content + event rows the previous transforms wrote for the same post', async () => {
    const deps = makeDeps();
    deps.contentService.search.mockResolvedValue([
      { id: 'old-content', type: 'reddit_post' },
      { id: 'unrelated', type: 'bookmark' },
    ] as never);
    deps.eventService.search.mockResolvedValue([
      { id: 'old-event', eventType: 'reddit_post' },
      { id: 'other-event', eventType: 'meeting' },
    ] as never);
    const { writer } = makeWriter(deps);

    await writer.write(ctx, postRecord(post));

    expect(deps.contentService.search).toHaveBeenCalledWith({ userId: 'user-1' }, { external_id: 't3_abc' });
    expect(deps.contentService.remove).toHaveBeenCalledTimes(1);
    expect(deps.contentService.remove).toHaveBeenCalledWith({ userId: 'user-1' }, 'old-content');
    expect(deps.eventService.search).toHaveBeenCalledWith(
      { userId: 'user-1' },
      expect.objectContaining({ sourceSystem: 'reddit', sourceId: 't3_abc' }),
    );
    expect(deps.eventService.remove).toHaveBeenCalledTimes(1);
    expect(deps.eventService.remove).toHaveBeenCalledWith({ userId: 'user-1' }, 'old-event');
  });
});

describe('saved listing', () => {
  it("a saved post is keyed saved_post — distinct from the user's own post of the same id", () => {
    const record = savedRecord({
      id: 'abc',
      name: 't3_abc',
      permalink: '/r/test/comments/abc/hello/',
      title: 'Hello',
      selftext: 'Body',
      url: 'https://www.reddit.com/r/test/comments/abc/hello/',
      subreddit: 'test',
      author: 'someone',
      score: 1,
      created_utc: 1700000000,
    });

    expect(record.kind).toBe('saved_post');
    expect(record.media).toBeNull();
    expect(redditIdentity(record.kind, record.fullname).id).toBe('reddit:saved_post:abc');
    expect(redditIdentity('post', record.fullname).id).not.toBe(
      redditIdentity(record.kind, record.fullname).id,
    );
  });

  it('a saved comment is told apart by its t1_ fullname and takes its media from the body', () => {
    const record = savedRecord({
      id: 'def',
      name: 't1_def',
      permalink: '/r/test/comments/abc/hello/def/',
      body: 'see https://i.imgur.com/x.png',
      link_title: 'Hello',
      subreddit: 'test',
      author: 'someone',
      score: 3,
      created_utc: 1700000000,
    });

    expect(record.kind).toBe('saved_comment');
    expect(record.title).toBeNull();
    expect(record.media).toEqual({ url: 'https://i.imgur.com/x.png', kind: 'image' });
  });

  it('a saved link post whose url differs from its permalink carries that url as media when it is one', () => {
    const record = savedRecord({
      id: 'ghi',
      name: 't3_ghi',
      permalink: '/r/pics/comments/ghi/cat/',
      title: 'Cat',
      url: 'https://i.redd.it/cat.png',
      subreddit: 'pics',
      author: 'someone',
      score: 9,
      created_utc: 1700000000,
    });

    expect(record.media).toEqual({ url: 'https://i.redd.it/cat.png', kind: 'image' });
  });

  it('the Saved transform writes content only — no communication, since the save time is unknown', async () => {
    const { writer, deps } = makeWriter();
    const service = new RedditSavedTransformService(writer, makeLogger() as never);

    await service.transform({
      connection,
      syncJob: syncJob({
        saved: [
          {
            id: 'abc',
            name: 't3_abc',
            permalink: '/r/test/comments/abc/hello/',
            title: 'Hello',
            selftext: 'Body',
            subreddit: 'test',
            author: 'someone',
            score: 1,
            created_utc: 1700000000,
          },
        ],
      }),
    });

    expect(deps.communicationService.create).not.toHaveBeenCalled();
    expect(deps.communicationService.update).not.toHaveBeenCalled();
    expect(deps.contentService.create).toHaveBeenCalledTimes(1);
    expect(rowOf(deps.contentService.create)).toMatchObject({
      type: 'social',
      title: 'Hello',
      text: 'Body',
      url: 'https://www.reddit.com/r/test/comments/abc/hello/',
      source_system: 'reddit',
      source_id: 'reddit:saved_post:abc',
      // The author's posting time survives as data, not as the record's time.
      source_data: expect.objectContaining({
        author: 'someone',
        item_created_at: '2023-11-14T22:13:20.000Z',
      }),
    });
  });

  it('a saved link post with media is the media row, same as the importer', async () => {
    const { writer, deps } = makeWriter();

    await writer.write(
      ctx,
      savedRecord({
        id: 'ghi',
        name: 't3_ghi',
        permalink: '/r/pics/comments/ghi/cat/',
        title: 'Cat',
        url: 'https://i.redd.it/cat.png',
        subreddit: 'pics',
        author: 'someone',
        score: 9,
        created_utc: 1700000000,
      }),
    );

    expect(deps.communicationService.create).not.toHaveBeenCalled();
    expect(rowOf(deps.contentService.create)).toMatchObject({
      type: 'image',
      url: 'https://i.redd.it/cat.png',
      mimetype: 'image/png',
      title: 'Cat',
      source_id: 'reddit:saved_post:ghi',
    });
  });

  it('removes the saved-item communication an earlier revision wrote under the same key', async () => {
    const deps = makeDeps();
    deps.communicationService.findBySource.mockResolvedValue({ id: 'stale-comm' } as never);
    const { writer } = makeWriter(deps);

    await writer.write(
      ctx,
      savedRecord({
        id: 'abc',
        name: 't3_abc',
        permalink: '/r/test/comments/abc/hello/',
        title: 'Hello',
        subreddit: 'test',
        author: 'someone',
        score: 1,
        created_utc: 1700000000,
      }),
    );

    expect(deps.communicationService.remove).toHaveBeenCalledWith({ userId: 'user-1' }, 'stale-comm');
    expect(deps.communicationService.update).not.toHaveBeenCalled();
  });

  it("does NOT touch a communication when the user's own post already exists (only saved keys are swept)", async () => {
    const deps = makeDeps();
    deps.communicationService.findBySource.mockResolvedValue({
      id: 'own-post',
      metadata: {},
      attachments: [],
    } as never);
    const { writer } = makeWriter(deps);

    await writer.write(ctx, postRecord(post));

    expect(deps.communicationService.remove).not.toHaveBeenCalled();
    expect(deps.communicationService.update).toHaveBeenCalledTimes(1);
  });
});

describe('listing transforms', () => {
  it('Posts and Comments hand every item to the writer and isolate a failing row', async () => {
    const { writer, deps } = makeWriter();
    deps.communicationService.create
      .mockRejectedValueOnce(new Error('boom') as never)
      .mockResolvedValue({ id: 'comm-2' } as never);
    const logger = makeLogger();

    await new RedditPostsTransformService(writer, logger as never).transform({
      connection,
      syncJob: syncJob({ posts: [post, { ...post, id: 'xyz', name: 't3_xyz' }] }),
    });
    await new RedditCommentsTransformService(writer, makeLogger() as never).transform({
      connection,
      syncJob: syncJob({ comments: [comment] }),
    });

    expect(deps.communicationService.create).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to transform Reddit post',
      expect.objectContaining({ name: 't3_abc', error: 'boom' }),
    );
  });
});
