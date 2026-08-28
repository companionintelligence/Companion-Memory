import type { RequestContext } from '@ci/common/context';

import type { ContentType } from '../../types/ContentType';
import { ContentResolver } from '../ContentResolver';

const CTX = { user: { id: 'user-1' } } as unknown as RequestContext;

function makeResolver() {
  const load = jest.fn(async () => ({
    status: 'ok',
    resolver: 'wikidata',
    title: 'Dark',
    authorName: null,
    authorUrl: null,
    siteName: 'Wikipedia',
    description: 'A family saga',
    canonicalUrl: 'https://en.wikipedia.org/wiki/Dark_(TV_series)',
    thumbnailUrl: '/ci-files/abc?X-Amz-Signature=x',
    durationSeconds: null,
    externalRef: 'wikidata:Q28443710',
    payload: { season: 1 },
    fetchedAt: new Date('2026-08-20T00:00:00Z'),
  }));
  const resolver = new ContentResolver(
    {} as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
    { load: jest.fn() } as never,
    { load } as never,
  );

  return { resolver, load };
}

function node(source: Partial<ContentType['__source']>): ContentType {
  return { __source: { userId: 'user-1', ...source } } as unknown as ContentType;
}

describe('ContentResolver.unfurl', () => {
  it('looks the cache up by the same key the stage derived, scoped to the row owner', async () => {
    const { resolver, load } = makeResolver();
    const view = await resolver.unfurl(
      CTX,
      node({
        sourceSystem: 'netflix',
        sourceData: { Title: 'Dark: Season 1: Alpha and Omega (Episode 10)' },
        userId: 'owner-9',
      }),
    );

    expect(load).toHaveBeenCalledWith({ userId: 'owner-9' }, 'wd:tv:dark');
    expect(view).toMatchObject({
      title: 'Dark',
      externalRef: 'wikidata:Q28443710',
      thumbnailUrl: '/ci-files/abc?X-Amz-Signature=x',
    });
  });

  it('stamps each row with ITS OWN episode coordinates over the shared work cache', async () => {
    const { resolver } = makeResolver();
    const ep10 = await resolver.unfurl(
      CTX,
      node({
        sourceSystem: 'netflix',
        sourceData: { Title: 'Dark: Season 1: Alpha and Omega (Episode 10)' },
      }),
    );
    const ep3 = await resolver.unfurl(
      CTX,
      node({ sourceSystem: 'netflix', sourceData: { Title: 'Dark: Season 2: Ghosts (Episode 3)' } }),
    );

    expect(ep10?.payload).toMatchObject({ season: 1, episode: 10, episode_title: 'Alpha and Omega' });
    expect(ep3?.payload).toMatchObject({ season: 2, episode: 3, episode_title: 'Ghosts' });
  });

  it('skips the loader entirely for a row with nothing resolvable', async () => {
    const { resolver, load } = makeResolver();
    expect(
      await resolver.unfurl(CTX, node({ sourceSystem: 'audible', sourceData: { Title: 'Snuff' } })),
    ).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });
});
