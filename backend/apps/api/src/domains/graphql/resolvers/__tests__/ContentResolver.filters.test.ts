import type { RequestContext } from '@ci/common/context';

import type { PaginationArgs } from '../../types/PaginationArgs';
import { ContentResolver } from '../ContentResolver';

/**
 * The content library's filters — type, mimetype and the How filter — ride the
 * `contents` query as explicit lists and reach ContentService.findPage as its
 * scoped filter, alongside the keyset the page already sent.
 */
describe('ContentResolver.contents filters', () => {
  const ctx = { userId: 'user-1' } as unknown as RequestContext;

  const makeResolver = () => {
    const findPage = jest.fn(async () => ({
      entities: [],
      hasNextPage: false,
      hasPreviousPage: false,
      totalCount: 0,
    }));
    const getFacets = jest.fn(async () => ({ types: ['image'], mimetypes: ['image/png'], sourceSystems: ['reddit'] }));
    const resolver = new ContentResolver(
      { findPage, getFacets } as never,
      { load: jest.fn() } as never,
      { load: jest.fn() } as never,
      { load: jest.fn() } as never,
      { load: jest.fn() } as never,
    );

    return { resolver, findPage, getFacets };
  };

  it('forwards each list as a filter, mapping connectors onto source_system', async () => {
    const { resolver, findPage } = makeResolver();

    await resolver.contents(ctx, { first: 50 } as PaginationArgs, ' shells ', ['image'], ['image/png'], ['reddit']);

    expect(findPage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      expect.objectContaining({ first: 50 }),
      { query: 'shells', types: ['image'], mimetypes: ['image/png'], sourceSystems: ['reddit'] },
    );
  });

  it('sends no filter at all for an unfiltered library', async () => {
    const { resolver, findPage } = makeResolver();

    await resolver.contents(ctx, { first: 50 } as PaginationArgs, '  ', undefined, [], undefined);

    expect(findPage).toHaveBeenCalledWith(expect.anything(), expect.anything(), {});
  });

  it('answers the facet query from the service', async () => {
    const { resolver, getFacets } = makeResolver();

    await expect(resolver.contentFacets(ctx)).resolves.toEqual({
      types: ['image'],
      mimetypes: ['image/png'],
      sourceSystems: ['reddit'],
    });
    expect(getFacets).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });
});
