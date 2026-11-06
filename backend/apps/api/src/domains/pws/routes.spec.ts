import { PwsUrls, parseRoute } from './routes';
import type { Route } from './routes';

const urls = new PwsUrls('https://example.com/');
const mounted = new PwsUrls('https://example.com/pws/');
const S = 'space-1';

const at = (path: string, u: PwsUrls = urls): Route => parseRoute(u, `${u.origin}${u.basePath}${path}`);

describe('PwsUrls', () => {
  it('derives every URL from the base, never from a request', () => {
    expect(urls.spaceUrl(S)).toBe('https://example.com/space/space-1/');
    expect(mounted.spaceUrl(S)).toBe('https://example.com/pws/space/space-1/');
    expect(mounted.collectionPath(S, 'c')).toBe('/pws/space/space-1/c/');
    expect(mounted.resourceUrl(S, 'c', 'r')).toBe('https://example.com/pws/space/space-1/c/r');
    expect(new PwsUrls('https://example.com:8443/pws').host).toBe('example.com:8443');
    expect(new PwsUrls('https://example.com/pws').basePath).toBe('/pws/');
  });

  it('refuses a base that cannot be one', () => {
    expect(() => new PwsUrls('ftp://example.com/')).toThrow();
    expect(() => new PwsUrls('https://example.com/?x=1')).toThrow();
    expect(() => new PwsUrls('not a url')).toThrow();
  });
});

describe('parseRoute', () => {
  it('reads each endpoint of the API summary', () => {
    const table: Array<[string, Route]> = [
      ['', { kind: 'root' }],
      ['service', { kind: 'service' }],
      ['spaces/', { kind: 'spaces' }],
      [`space/${S}/`, { kind: 'space', spaceId: S }],
      [`space/${S}/meta`, { kind: 'space-meta', spaceId: S }],
      [`space/${S}/linkset`, { kind: 'space-linkset', spaceId: S }],
      [`space/${S}/policy`, { kind: 'space-policy', spaceId: S }],
      [`space/${S}/quotas`, { kind: 'space-optional', spaceId: S, segment: 'quotas' }],
      [`space/${S}/backends`, { kind: 'space-optional', spaceId: S, segment: 'backends' }],
      [`space/${S}/export`, { kind: 'space-optional', spaceId: S, segment: 'export' }],
      [`space/${S}/import`, { kind: 'space-optional', spaceId: S, segment: 'import' }],
      [`space/${S}/query`, { kind: 'space-optional', spaceId: S, segment: 'query' }],
      [`space/${S}/c/`, { kind: 'collection', spaceId: S, collectionId: 'c' }],
      [`space/${S}/c/meta`, { kind: 'collection-meta', spaceId: S, collectionId: 'c' }],
      [`space/${S}/c/meta/log`, { kind: 'collection-meta-log', spaceId: S, collectionId: 'c' }],
      [`space/${S}/c/linkset`, { kind: 'collection-linkset', spaceId: S, collectionId: 'c' }],
      [`space/${S}/c/policy`, { kind: 'collection-policy', spaceId: S, collectionId: 'c' }],
      [
        `space/${S}/c/backend`,
        { kind: 'collection-optional', spaceId: S, collectionId: 'c', segment: 'backend' },
      ],
      [
        `space/${S}/c/quota`,
        { kind: 'collection-optional', spaceId: S, collectionId: 'c', segment: 'quota' },
      ],
      [
        `space/${S}/c/query`,
        { kind: 'collection-optional', spaceId: S, collectionId: 'c', segment: 'query' },
      ],
      [`space/${S}/c/r`, { kind: 'resource', spaceId: S, collectionId: 'c', resourceId: 'r' }],
      [`space/${S}/c/r/meta`, { kind: 'resource-meta', spaceId: S, collectionId: 'c', resourceId: 'r' }],
      [`space/${S}/c/r/policy`, { kind: 'resource-policy', spaceId: S, collectionId: 'c', resourceId: 'r' }],
      [`space/${S}/c/r/chunks`, { kind: 'resource-chunks', spaceId: S, collectionId: 'c', resourceId: 'r' }],
      [`space/${S}/c/r/chunks/`, { kind: 'resource-chunks', spaceId: S, collectionId: 'c', resourceId: 'r' }],
      [
        `space/${S}/c/r/chunks/3`,
        { kind: 'resource-chunks', spaceId: S, collectionId: 'c', resourceId: 'r', chunk: '3' },
      ],
      [`space/${S}/collections`, { kind: 'retired-collections', spaceId: S, location: `/space/${S}/` }],
      [`space/${S}/collections/`, { kind: 'retired-collections', spaceId: S, location: `/space/${S}/` }],
    ];
    for (const [path, route] of table) {
      expect(at(path)).toEqual(route);
    }
  });

  it('is relative to the mount path, and refuses anything outside it or on another origin', () => {
    expect(at(`space/${S}/`, mounted)).toEqual({ kind: 'space', spaceId: S });
    expect(parseRoute(mounted, `https://example.com/space/${S}/`)).toEqual({ kind: 'unknown' });
    expect(parseRoute(urls, `https://evil.example/space/${S}/`)).toEqual({ kind: 'unknown' });
    expect(parseRoute(urls, 'not a url')).toEqual({ kind: 'unknown' });
  });

  it('turns the other spelling into a redirect to the canonical one, keeping the query', () => {
    expect(at(`space/${S}`)).toEqual({ kind: 'redirect', location: `/space/${S}/` });
    expect(at(`space/${S}/c?limit=2`)).toEqual({
      kind: 'redirect',
      location: `/space/${S}/c/?limit=2`,
    });
    expect(at(`space/${S}/c/r/`)).toEqual({
      kind: 'redirect',
      location: `/space/${S}/c/r`,
    });
    expect(at(`space/${S}/c/meta/`)).toEqual({
      kind: 'redirect',
      location: `/space/${S}/c/meta`,
    });
    expect(at(`space/${S}/meta/`)).toEqual({
      kind: 'redirect',
      location: `/space/${S}/meta`,
    });
    expect(at('spaces')).toEqual({ kind: 'redirect', location: '/spaces/' });
  });

  it('names an illegal id by its level and routes nothing it cannot name', () => {
    expect(at(`space/${'x'.repeat(129)}/`)).toEqual({ kind: 'invalid-id', level: 'space' });
    expect(at(`space/${S}/a$b/`)).toEqual({ kind: 'invalid-id', level: 'collection' });
    expect(at(`space/${S}/c/a$b`)).toEqual({ kind: 'invalid-id', level: 'resource' });
    for (const path of [
      'nothing',
      'space',
      'space//x',
      `space/${S}//meta`,
      `space/%41/`,
      `space/${S}/policy/meta`,
      `space/${S}/c/policy/meta`,
      `space/${S}/c/r/other`,
      `space/${S}/c/r/meta/x`,
      'service/x',
      'spaces/x',
    ]) {
      expect(['unknown', 'redirect']).toContain(at(path).kind);
    }
    expect(at(`space/${S}/policy/meta`)).toEqual({ kind: 'unknown' });
    expect(at(`space/${S}/c/policy/meta`)).toEqual({ kind: 'unknown' });
  });

  it('lets a Resource be called anything that is not reserved at its level', () => {
    for (const id of ['chunks', 'collections', 'log', 'quotas', 'backends']) {
      expect(at(`space/${S}/c/${id}`)).toEqual({
        kind: 'resource',
        spaceId: S,
        collectionId: 'c',
        resourceId: id,
      });
    }
  });
});

describe('parseRoute: only a path the URL parser leaves alone is routed', () => {
  it('refuses dot segments in every spelling, under the root and under a mount path', () => {
    for (const u of [urls, mounted]) {
      for (const path of [
        `space/${S}/c/../c/a`,
        `space/${S}/c/./a`,
        `space/${S}/c/%2e%2e/c/a`,
        `space/${S}/c/%2E%2E/c/a`,
        `space/${S}/c/.%2e/c/a`,
        `space/${S}/c/%2e./c/a`,
        `space/${S}/c/..\\c/a`,
        `space/${S}/c/..`,
        `space/${S}/..`,
        `space/${S}/c/\ta`,
      ]) {
        expect([path, at(path, u)]).toEqual([path, { kind: 'unknown' }]);
      }
    }
  });

  it('still routes a path that merely has dots or a tilde in an id, and dots in the query', () => {
    expect(at(`space/${S}/c/a.b~c`)).toMatchObject({ kind: 'resource', resourceId: 'a.b~c' });
    expect(at(`space/${S}/c/a?x=1`)).toMatchObject({ kind: 'resource' });
    expect(at(`space/${S}/c/?limit=2&x=../y`)).toMatchObject({ kind: 'collection' });
  });
});
