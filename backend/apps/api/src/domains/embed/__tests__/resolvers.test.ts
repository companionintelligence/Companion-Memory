import type { ResolveTarget } from '../resolveKey';
import { dataFromOEmbed, OEmbedResolver } from '../resolvers/OEmbedResolver';
import { dataFromHead, OpenGraphResolver, parseHead } from '../resolvers/OpenGraphResolver';
import {
  candidateTitles,
  classifyEntity,
  dataFromEntity,
  parseEntity,
  pickEntity,
  titlesResemble,
  WikidataResolver,
} from '../resolvers/WikidataResolver';
import type { FetchOutcome, UnfurlFetcher } from '../services/UnfurlFetcher';

function fakeFetcher(answer: (url: string) => FetchOutcome): UnfurlFetcher {
  return { get: jest.fn(async (url: string) => answer(url)) } as unknown as UnfurlFetcher;
}

const ok = (url: string, body: unknown, contentType = 'application/json'): FetchOutcome => ({
  kind: 'ok',
  status: 200,
  url,
  contentType,
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
});

describe('OEmbedResolver', () => {
  const target: ResolveTarget = {
    resolver: 'oembed',
    key: 'oembed:youtube:video:dQw4w9WgXcQ',
    url: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
    providerRef: 'youtube:video:dQw4w9WgXcQ',
  };

  it('calls the provider endpoint with the page URL and maps the response', async () => {
    const fetcher = fakeFetcher((url) =>
      ok(url, {
        title: 'Rick Astley - Never Gonna Give You Up',
        author_name: 'Rick Astley',
        author_url: 'https://www.youtube.com/@RickAstleyYT',
        provider_name: 'YouTube',
        thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        thumbnail_width: 480,
        html: '<iframe …></iframe>',
      }),
    );

    const out = await new OEmbedResolver().resolve(target, fetcher);
    expect((fetcher.get as jest.Mock).mock.calls[0][0]).toBe(
      'https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ',
    );
    expect(out).toEqual({
      status: 'ok',
      data: {
        title: 'Rick Astley - Never Gonna Give You Up',
        authorName: 'Rick Astley',
        authorUrl: 'https://www.youtube.com/@RickAstleyYT',
        siteName: 'YouTube',
        description: undefined,
        canonicalUrl: target.url,
        thumbnailUrl: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        durationSeconds: undefined,
        payload: { provider_name: 'YouTube', thumbnail_width: 480 },
      },
    });
  });

  it('maps HTTP statuses to the stored vocabulary', async () => {
    const r = new OEmbedResolver();
    expect(
      await r.resolve(
        target,
        fakeFetcher((url) => ({ kind: 'status', status: 404, url })),
      ),
    ).toEqual({ status: 'not_found' });
    expect(
      await r.resolve(
        target,
        fakeFetcher((url) => ({ kind: 'status', status: 401, url })),
      ),
    ).toMatchObject({ status: 'not_embeddable' });
    expect(
      await r.resolve(
        target,
        fakeFetcher((url) => ({ kind: 'status', status: 429, url })),
      ),
    ).toEqual({ status: 'rate_limited' });
    expect(
      await r.resolve(
        target,
        fakeFetcher((url) => ({ kind: 'blocked', url })),
      ),
    ).toEqual({ status: 'blocked' });
    expect(
      await r.resolve(
        target,
        fakeFetcher((url) => ({ kind: 'timeout', url })),
      ),
    ).toMatchObject({ status: 'transport_error' });
  });

  it('treats an empty 200 (a delisted Spotify track) as not_found', async () => {
    const out = await new OEmbedResolver().resolve(
      {
        ...target,
        providerRef: 'spotify:track:3fzTpBMSQKjo9sW0T8Tw2O',
        url: 'https://open.spotify.com/track/3fzTpBMSQKjo9sW0T8Tw2O',
      },
      fakeFetcher((url) =>
        ok(url, { html: '<iframe …>', provider_name: 'Spotify', type: 'rich', title: '' }),
      ),
    );
    expect(out).toEqual({ status: 'not_found', detail: 'empty_oembed' });
  });

  it('drops non-http thumbnail/author URLs', () => {
    expect(
      dataFromOEmbed({ thumbnail_url: 'javascript:alert(1)', author_url: 'ftp://x' }, 'https://a'),
    ).toMatchObject({
      thumbnailUrl: undefined,
      authorUrl: undefined,
    });
  });
});

describe('WikidataResolver', () => {
  const dark: ResolveTarget = {
    resolver: 'wikidata',
    key: 'wd:tv:dark',
    work: { kind: 'tv', title: 'Dark', season: 1, episode: 10 },
  };

  const entity = (id: string, extra: Record<string, unknown>, claims: Record<string, unknown[]> = {}) => ({
    id,
    labels: { en: { value: extra.label } },
    descriptions: { en: { value: extra.description } },
    sitelinks: extra.enwiki ? { enwiki: { title: extra.enwiki } } : {},
    claims: Object.fromEntries(
      Object.entries(claims).map(([p, vals]) => [
        p,
        vals.map((value) => ({ mainsnak: { datavalue: { value } } })),
      ]),
    ),
  });

  const darkSeries = entity(
    'Q28443710',
    { label: 'Dark', description: '2017 German science fiction TV series', enwiki: 'Dark (TV series)' },
    {
      P31: [{ id: 'Q5398426' }],
      P154: ['Dark logo.png'],
      P580: [{ time: '+2017-12-01T00:00:00Z' }],
      P345: ['tt5753856'],
      P1113: [{ amount: '+26' }],
      P2437: [{ amount: '+3' }],
    },
  );
  const darkness = entity(
    'Q204170',
    { label: 'darkness', description: 'lack of light', enwiki: 'Darkness' },
    { P31: [{ id: 'Q16889133' }] },
  );

  it('resolves through the naming-convention title, gates on P31, and reads Commons + summary', async () => {
    const calls: string[] = [];
    const fetcher = fakeFetcher((url) => {
      calls.push(url);
      if (url.includes('en.wikipedia.org/w/api.php') && url.includes('titles=')) {
        return ok(url, {
          query: {
            redirects: [{ from: 'Dark', to: 'Darkness' }],
            pages: {
              '-1': { title: 'Dark (miniseries)', missing: '' },
              '1': { title: 'Dark (TV series)', pageprops: { wikibase_item: 'Q28443710' } },
              '2': { title: 'Darkness', pageprops: { wikibase_item: 'Q204170' } },
            },
          },
        });
      }

      if (url.includes('wikidata.org')) {
        return ok(url, { entities: { Q28443710: darkSeries, Q204170: darkness } });
      }

      if (url.includes('/page/summary/')) {
        return ok(url, {
          description: '2017 German science-fiction television series',
          extract: 'Dark is a German science-fiction mystery thriller…',
        });
      }

      throw new Error(`unexpected ${url}`);
    });

    const out = await new WikidataResolver().resolve(dark, fetcher);
    expect(calls.map((c) => new URL(c).host)).toEqual([
      'en.wikipedia.org',
      'www.wikidata.org',
      'en.wikipedia.org',
    ]);
    expect(out).toMatchObject({
      status: 'ok',
      data: {
        title: 'Dark',
        description: 'Dark is a German science-fiction mystery thriller…',
        siteName: 'Wikipedia',
        canonicalUrl: 'https://en.wikipedia.org/wiki/Dark_(TV_series)',
        thumbnailUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Dark_logo.png?width=500',
        externalRef: 'wikidata:Q28443710',
        payload: { year: 2017, imdb_id: 'tt5753856', episodes: 26, seasons: 3, image_source: 'P154' },
      },
    });
    // Shared by every episode of the work, so it must carry none of them.
    expect((out as { data: { payload: Record<string, unknown> } }).data.payload).not.toHaveProperty('season');
  });

  it('falls back to full-text search when no convention title hits, preserving search rank', async () => {
    const kimmy = entity(
      'Q18128516',
      {
        label: 'Unbreakable Kimmy Schmidt',
        description: 'American sitcom',
        enwiki: 'Unbreakable Kimmy Schmidt',
      },
      { P31: [{ id: 'Q5398426' }] },
    );
    const fetcher = fakeFetcher((url) => {
      if (url.includes('titles=')) {
        return ok(url, {
          query: { pages: { '-1': { title: 'Unbreakable Kimmy Schmidt (TV series)', missing: '' } } },
        });
      }

      if (url.includes('generator=search')) {
        return ok(url, {
          query: {
            pages: {
              '9': { index: 2, title: 'Ellie Kemper', pageprops: { wikibase_item: 'Q258505' } },
              '4': {
                index: 1,
                title: 'Unbreakable Kimmy Schmidt',
                pageprops: { wikibase_item: 'Q18128516' },
              },
            },
          },
        });
      }

      if (url.includes('wikidata.org')) {
        return ok(url, {
          entities: {
            Q18128516: kimmy,
            Q258505: entity(
              'Q258505',
              { label: 'Ellie Kemper', description: 'American actress' },
              { P31: [{ id: 'Q5' }] },
            ),
          },
        });
      }

      return ok(url, {});
    });

    const out = await new WikidataResolver().resolve(
      {
        resolver: 'wikidata',
        key: 'wd:tv:unbreakable kimmy schmidt',
        work: { kind: 'tv', title: 'Unbreakable Kimmy Schmidt' },
      },
      fetcher,
    );
    expect(out).toMatchObject({
      status: 'ok',
      data: { externalRef: 'wikidata:Q18128516', title: 'Unbreakable Kimmy Schmidt' },
    });
  });

  it('rejects disambiguation pages and people, and reports not_found', async () => {
    const fetcher = fakeFetcher((url) => {
      if (url.includes('titles=') || url.includes('generator=search')) {
        return ok(url, { query: { pages: { '1': { title: 'Foo', pageprops: { wikibase_item: 'Q1' } } } } });
      }

      return ok(url, {
        entities: {
          Q1: entity(
            'Q1',
            { label: 'Foo', description: 'Wikimedia disambiguation page' },
            { P31: [{ id: 'Q4167410' }] },
          ),
        },
      });
    });
    expect(
      await new WikidataResolver().resolve(
        { resolver: 'wikidata', key: 'wd:movie:foo', work: { kind: 'movie', title: 'Foo' } },
        fetcher,
      ),
    ).toEqual({
      status: 'not_found',
    });
  });

  it('prefers a freely licensed poster over the article image, and exposes duration for films', () => {
    const film = parseEntity(
      entity(
        'Q37342034',
        {
          label: 'The Ballad of Buster Scruggs',
          description: '2018 film',
          enwiki: 'The Ballad of Buster Scruggs',
        },
        {
          P31: [{ id: 'Q11424' }],
          P18: ['The-ballad-of-buster-scruggs.png'],
          P3383: ['Buster poster.jpg'],
          P2047: [{ amount: '+133' }],
          P577: [{ time: '+2018-08-31T00:00:00Z' }],
        },
      ),
    );
    expect(classifyEntity(film)).toBe('movie');
    expect(dataFromEntity(film)).toMatchObject({
      thumbnailUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Buster_poster.jpg?width=500',
      durationSeconds: 133 * 60,
      payload: { year: 2018, image_source: 'P3383', media_type: 'movie' },
    });
  });

  it('picks the exact-title entity of the right kind over a popular partial match', () => {
    const knight = parseEntity(
      entity(
        'Q163872',
        { label: 'The Dark Knight', description: '2008 film', enwiki: 'The Dark Knight' },
        { P31: [{ id: 'Q11424' }] },
      ),
    );
    const darkTv = parseEntity(darkSeries);
    expect(pickEntity([knight, darkTv], { kind: 'tv', title: 'Dark' })?.id).toBe('Q28443710');
    expect(pickEntity([knight, darkTv], { kind: 'movie', title: 'Dark' })?.id).toBe('Q28443710'); // cross-kind exact label
    expect(candidateTitles({ kind: 'tv', title: 'Dark' })[0]).toBe('Dark (TV series)');
  });

  it('refuses a same-kind candidate whose name does not resemble the work', () => {
    const other = parseEntity(
      entity(
        'Q5151551',
        { label: 'Comes a Bright Day', description: '2012 film', enwiki: 'Comes a Bright Day' },
        { P31: [{ id: 'Q11424' }] },
      ),
    );
    expect(pickEntity([other], { kind: 'movie', title: 'Sam Smith: Dreams Come True' })).toBeUndefined();
    const close = parseEntity(
      entity(
        'Q1',
        { label: 'Sam Smith: Dreams Come True – The Film', description: '2015 film' },
        { P31: [{ id: 'Q11424' }] },
      ),
    );
    expect(pickEntity([other, close], { kind: 'movie', title: 'Sam Smith: Dreams Come True' })?.id).toBe(
      'Q1',
    );
    expect(titlesResemble('Stargate SG-1 (TV series)', 'Stargate SG-1')).toBe(true);
    expect(titlesResemble('The Dark Knight', 'Dark')).toBe(true); // containment — exactness is decided earlier
    expect(titlesResemble('Ellie Kemper', 'Unbreakable Kimmy Schmidt')).toBe(false);
  });
});

describe('OpenGraphResolver', () => {
  const page = `<!doctype html><html><head>
    <title>Fallback &amp; Title</title>
    <meta property="og:title" content="People running backwards" />
    <meta content="A gif" property='og:description'>
    <meta property="og:image" content="/img/preview.png">
    <meta property="og:site_name" content="Reddit">
    <meta property="og:video:duration" content="42">
    <link rel="alternate" type="application/json+oembed" href="/oembed?x=1">
    </head><body><meta property="og:title" content="BODY MUST NOT WIN"></body></html>`;

  it('parses the head only, resolves relative images, and discovers oEmbed', () => {
    const head = parseHead(page, 'https://www.reddit.com/r/gifs/comments/459icd/');
    expect(head.title).toBe('Fallback & Title');
    expect(head.oembedHref).toBe('https://www.reddit.com/oembed?x=1');
    expect(dataFromHead(head, 'https://www.reddit.com/r/gifs/comments/459icd/')).toMatchObject({
      title: 'People running backwards',
      description: 'A gif',
      siteName: 'Reddit',
      thumbnailUrl: 'https://www.reddit.com/img/preview.png',
      durationSeconds: 42,
    });
  });

  it('merges discovered oEmbed over the meta tags', async () => {
    const target: ResolveTarget = {
      resolver: 'opengraph',
      key: 'og:https://reddit.com/x',
      url: 'https://www.reddit.com/x',
    };
    const fetcher = fakeFetcher((url) =>
      url.includes('/oembed')
        ? ok(url, { title: 'Better title', author_name: 'u/someone' })
        : ok(url, page, 'text/html; charset=utf-8'),
    );
    const out = await new OpenGraphResolver().resolve(target, fetcher);
    expect(out).toMatchObject({
      status: 'ok',
      data: {
        title: 'Better title',
        authorName: 'u/someone',
        siteName: 'Reddit',
        payload: { oembed_discovered: true },
      },
    });
  });

  it('treats a direct image as its own thumbnail and other binaries as not embeddable', async () => {
    const target: ResolveTarget = {
      resolver: 'opengraph',
      key: 'og:https://i.redd.it/a.png',
      url: 'https://i.redd.it/a.png',
    };
    expect(
      await new OpenGraphResolver().resolve(
        target,
        fakeFetcher((url) => ok(url, 'x', 'image/png')),
      ),
    ).toMatchObject({
      status: 'ok',
      data: { thumbnailUrl: 'https://i.redd.it/a.png' },
    });
    expect(
      await new OpenGraphResolver().resolve(
        target,
        fakeFetcher((url) => ok(url, 'x', 'application/pdf')),
      ),
    ).toMatchObject({
      status: 'not_embeddable',
    });
  });

  it('is not_embeddable for a page with no usable metadata', async () => {
    const target: ResolveTarget = {
      resolver: 'opengraph',
      key: 'og:https://x.test/',
      url: 'https://x.test/',
    };
    expect(
      await new OpenGraphResolver().resolve(
        target,
        fakeFetcher((url) => ok(url, '<html><head></head></html>', 'text/html')),
      ),
    ).toMatchObject({
      status: 'not_embeddable',
      detail: 'no_metadata',
    });
  });
});
