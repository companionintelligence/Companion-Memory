import fs from 'node:fs';
import os from 'node:os';
import path from 'path';

import { RedditFileImporter } from '../reddit';
import type { ImportParams } from '../timeline';

import type { EmittedGraph } from './support/emitted';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Write a one-off CSV to a temp dir and import just that file.
async function importCsv(name: string, csv: string): Promise<EmittedGraph[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reddit-'));
  const fpath = path.join(dir, name);
  fs.writeFileSync(fpath, csv);
  const pipeline: EmittedGraph[] = [];
  await new RedditFileImporter().fileImport({}, { filename: name, fullPath: fpath }, {
    pipeline,
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return pipeline;
}

describe('Reddit datasource', () => {
  it('recognizes directory with multiple Reddit CSVs', async () => {
    const root = path.join(FIXTURES_DIR, 'reddit-export');
    const fi = new RedditFileImporter();
    const rec = await fi.recognize({}, { filename: 'reddit-export', fullPath: root });
    expect(rec.confidence).toBeGreaterThan(0.9);
  });

  it('recognizes single posts.csv file', async () => {
    const fpath = path.join(FIXTURES_DIR, 'reddit-export', 'posts.csv');
    const fi = new RedditFileImporter();
    const rec = await fi.recognize({}, { filename: 'posts.csv', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('imports posts and comments as social items', async () => {
    const root = path.join(FIXTURES_DIR, 'reddit-export');
    const fi = new RedditFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'reddit-export', fullPath: root }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(4); // 2 posts + 2 comments
    expect(pipeline.every((p) => p.item.classification === 'social')).toBe(true);
  });

  it('parses post metadata correctly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'reddit-export', 'posts.csv');
    const fi = new RedditFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'posts.csv', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(2);
    expect(pipeline[0].item.metadata.Title).toBe('My First Reddit Post');
    expect(pipeline[0].item.metadata.Kind).toBe('post');
    expect(pipeline[0].item.metadata.Source).toBe('Reddit');
    expect(pipeline[0].item.timestamp).toBeDefined();
  });

  it('parses comment metadata correctly', async () => {
    const fpath = path.join(FIXTURES_DIR, 'reddit-export', 'comments.csv');
    const fi = new RedditFileImporter();
    const pipeline: EmittedGraph[] = [];
    await fi.fileImport({}, { filename: 'comments.csv', fullPath: fpath }, {
      pipeline,
      timeframe: {},
      log: () => {},
    } as unknown as ImportParams);

    expect(pipeline.length).toBe(2);
    expect(pipeline[0].item.metadata.Kind).toBe('comment');
    expect(pipeline[0].item.metadata.Score).toBe(42);
  });

  // A comment has no title of its own; the old body-snippet title just
  // duplicated the text the content/Body already carries.
  it('stamps no Title on comments', async () => {
    const pipeline = await importCsv(
      'comments.csv',
      'id,permalink,date,subreddit,body\n' +
        'c1,/r/test/comments/abc/hello_there/,2022-01-01 00:00:00 UTC,test,"Great shot, which trail is this?"\n',
    );
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.metadata.Title).toBeUndefined();
    const text = await pipeline[0].item.content.data!();
    expect(text.toString()).toBe('Great shot, which trail is this?');
  });

  it('derives a saved-post title from the permalink slug (no post.txt fallback)', async () => {
    const pipeline = await importCsv(
      'saved_posts.csv',
      'id,permalink\nxfkamy,https://www.reddit.com/r/ecommerce/comments/xfkamy/made_a_shopping_district_experience/\n',
    );
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.metadata.Title).toBe('Made a shopping district experience');
    expect(pipeline[0].item.metadata.Title).not.toBe('post.txt');
    expect(pipeline[0].item.metadata.Subreddit).toBe('ecommerce');
    expect(pipeline[0].item.metadata.Kind).toBe('saved_post');
  });

  it('uses the post body as content and captures the external url', async () => {
    const pipeline = await importCsv(
      'posts.csv',
      'id,permalink,date,ip,subreddit,gildings,title,url,body\n' +
        'abc,/r/test/comments/abc/hello/,2022-01-01 00:00:00 UTC,,test,0,Hello,https://example.com,Body text here\n',
    );
    expect(pipeline.length).toBe(1);
    const text = await pipeline[0].item.content.data!();
    expect(text.toString()).toBe('Body text here');
    expect(pipeline[0].item.metadata.URL).toBe('https://example.com');
  });

  // The submission IP is kept as metadata (see clientIP) — never geolocated.
  it('records the submission IP on posts and comments, and omits it when blank', async () => {
    const posts = await importCsv(
      'posts.csv',
      'id,permalink,date,ip,subreddit,title,body\n' +
        'abc,/r/test/comments/abc/hello/,2022-01-01 00:00:00 UTC,203.0.113.42,test,Hello,Body\n' +
        'def,/r/test/comments/def/quiet/,2022-01-02 00:00:00 UTC,,test,Quiet,Body\n',
    );
    expect(posts[0].item.metadata.IP).toBe('203.0.113.42');
    expect(posts[1].item.metadata.IP).toBeUndefined();

    const comments = await importCsv(
      'comments.csv',
      'id,permalink,date,ip,subreddit,body\n' +
        'c1,/r/test/comments/abc/hello/c1/,2022-01-01 00:00:00 UTC,2001:db8::1,test,Nice\n',
    );
    expect(comments[0].item.metadata.IP).toBe('2001:db8::1');
  });

  it('does NOT import subscribed subreddits (dateless — useless on a timeline)', async () => {
    const pipeline = await importCsv('subscribed_subreddits.csv', 'subreddit\nmetaverse\nwebvr\n');
    expect(pipeline.length).toBe(0);
  });

  it('still imports moderated subreddits', async () => {
    const pipeline = await importCsv('moderated_subreddits.csv', 'subreddit\nmetaverse\n');
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.metadata.Kind).toBe('moderated_subreddit');
  });

  // Regression: timestamp-less items (subreddits) share a constant filename,
  // so without a distinct id they collapse to one row in the
  // (data_source, content_hash) dedup. Every item must carry a unique id.
  it('gives every timestamp-less item a distinct dedup id', async () => {
    const subs = await importCsv('moderated_subreddits.csv', 'subreddit\nmetaverse\nwebvr\nscience\n');
    expect(new Set(subs.map((p) => p.item.id!)).size).toBe(3);
  });

  it('does NOT import votes (dateless — useless on a timeline)', async () => {
    for (const name of ['post_votes.csv', 'comment_votes.csv']) {
      const votes = await importCsv(
        name,
        'id,permalink,direction\n' +
          'a1,/r/x/comments/a1/some_post/,up\n' +
          'b2,/r/y/comments/b2/other_post/,down\n',
      );
      expect(votes.length).toBe(0);
    }
  });

  it('imports private messages as communications with participants', async () => {
    const pipeline = await importCsv(
      'messages_archive.csv',
      'id,permalink,thread_id,date,ip,from,to,subject,body\n' +
        'm1,/message/messages/m1,t1,2020-03-04 12:00:00 UTC,,alice,bob,Re: project,Sounds good — ship it.\n',
    );
    expect(pipeline.length).toBe(1);
    const it0 = pipeline[0].item;
    expect(it0.classification).toBe('message');
    expect(it0.metadata.From).toBe('alice');
    expect(it0.metadata.To).toBe('bob');
    expect(it0.metadata.Subject).toBe('Re: project');
    expect(it0.metadata.Body).toBe('Sounds good — ship it.');
    expect(it0.metadata.ThreadId).toBe('t1');
    expect(it0.timestamp).toBeDefined();
    expect(it0.id).toBe('reddit:message:m1');
  });

  // Regression: a real messages_archive.csv export carries no thread_id,
  // thread_parent_message_id, channel_url, or channel_name column at all —
  // those only exist on chat_history.csv. Without a fallback, every private
  // message lands with ThreadId undefined and thread_id NULL in the
  // database — 19 rows on the reference corpus, all private messages, each
  // its own orphan thread instead of grouped with the rest of that
  // conversation.
  it('derives a thread key for private messages from the correspondent pair when the export names no thread', () => {
    const csv =
      'id,permalink,date,from,to,subject,body\n' +
      'm1,/message/messages/m1,2020-03-04 12:00:00 UTC,alice,bob,Re: project,First reply.\n' +
      'm2,/message/messages/m2,2020-03-04 12:05:00 UTC,bob,alice,Re: project,Second reply.\n';

    return importCsv('messages_archive.csv', csv).then((pipeline) => {
      expect(pipeline.length).toBe(2);
      const [m1, m2] = pipeline.map((p) => p.item);
      expect(m1.metadata.ThreadId).toBeTruthy();
      // Order-independent: alice→bob and bob→alice are the same conversation.
      expect(m1.metadata.ThreadId).toBe(m2.metadata.ThreadId);
    });
  });

  it('does not fabricate a thread key when a private message names no correspondent', async () => {
    const csv = 'id,permalink,date,from,to,subject,body\nm1,/message/messages/m1,2020-03-04 12:00:00 UTC,,,,Body only.\n';
    const pipeline = await importCsv('messages_archive.csv', csv);
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.metadata.ThreadId).toBeUndefined();
  });

  // Regression: announcements.csv ("official communication about your account
  // from Reddit in your inbox" per Reddit's export docs) was missing from
  // REDDIT_FILES entirely, so a real 38-file export's admin notification was
  // never even read, let alone imported. It's message-shaped (subject/body/
  // from/sent_at), so it should route through the same message-import path as
  // messages_archive.csv/chat_history.csv.
  it('imports announcements.csv as a message with the admin subject/body/timestamp', async () => {
    const body = 'Thanks for signing up, here is how to get started.';
    const csv =
      'id,from,subject,body,sent_at\n' + `a1,reddit,Welcome to Reddit!,"${body}",2020-01-15 09:30:00 UTC\n`;
    const pipeline = await importCsv('announcements.csv', csv);
    expect(pipeline.length).toBe(1);
    const it0 = pipeline[0].item;
    expect(it0.classification).toBe('message');
    expect(it0.metadata.Subject).toBe('Welcome to Reddit!');
    expect(it0.metadata.Body).toBe(body);
    expect(it0.metadata.From).toBe('reddit');
    expect(it0.metadata.Kind).toBe('message');
    expect(it0.metadata.ConversationType).toBe('announcement');
    expect(it0.timestamp).toBeDefined();
    expect(it0.timestamp!.toISOString()).toBe('2020-01-15T09:30:00.000Z');
    expect(it0.id).toBe('reddit:message:a1');
    const text = await it0.content.data!();
    expect(text.toString()).toBe(body);
  });

  // announcements.csv must also be recognized so a directory drop containing
  // it (without any other Reddit CSV) is still identified as a Reddit export.
  it('recognizes a lone announcements.csv file', async () => {
    const fi = new RedditFileImporter();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reddit-'));
    const fpath = path.join(dir, 'announcements.csv');
    fs.writeFileSync(fpath, 'id,from,subject,body,sent_at\na1,reddit,Hi,Hello,2020-01-01 00:00:00 UTC\n');
    const rec = await fi.recognize({}, { filename: 'announcements.csv', fullPath: fpath });
    expect(rec.confidence).toBeGreaterThan(0.8);
  });

  it('imports reddit purchases as dated commerce records', async () => {
    const pipeline = await importCsv(
      'purchases.csv',
      'processor,transaction_id,product,date,cost,currency,status\n' +
        'stripe,tx1,500 Reddit Coins,2021-05-01 00:00:00 UTC,1.99,USD,completed\n',
    );
    expect(pipeline.length).toBe(1);
    expect(pipeline[0].item.classification).toBe('purchase');
    expect(pipeline[0].item.metadata.Product).toBe('500 Reddit Coins');
    // The canonical TOTAL key, not `Cost`: no price chain ever read `Cost`, so
    // every Reddit purchase used to reach ci.* priceless.
    expect(pipeline[0].item.metadata.Total).toBe('1.99');
    expect(pipeline[0].item.metadata.Cost).toBeUndefined();
    // Reddit sells Coins, Awards and Premium — never a physical good.
    expect(pipeline[0].item.metadata.IsDigital).toBe(true);
    expect(pipeline[0].item.metadata.Merchant).toBe('Reddit');
    // The PAYMENT processor stays out of the merchant chain.
    expect(pipeline[0].item.metadata.Processor).toBe('stripe');
    expect(pipeline[0].item.timestamp).toBeDefined();
  });
});
