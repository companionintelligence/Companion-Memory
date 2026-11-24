import { evaluatePreconditions, parseEtagList } from './conditional';
import { bump, etagOf, newValidator } from './models';
import { DEFAULT_PAGE_LIMIT, encodeCursor, nextLink, readPageRequest } from './pagination';
import { PwsError, methodNotAllowed, notFound } from './problems';

const input = (over: Partial<Parameters<typeof evaluatePreconditions>[0]>) => ({
  method: 'PUT',
  ifMatch: undefined,
  ifNoneMatch: undefined,
  currentEtag: '"a.1"',
  ...over,
});

describe('validators', () => {
  it('are strong ETags that change on every write and never repeat for a re-created entity', () => {
    const v = newValidator();
    expect(etagOf(v)).toMatch(/^"[a-z0-9]+\.1"$/);
    expect(etagOf(bump(v))).not.toBe(etagOf(v));
    expect(etagOf(newValidator())).not.toBe(etagOf(newValidator()));
  });
});

describe('parseEtagList', () => {
  it('reads *, strong and weak tags, and ignores junk', () => {
    expect(parseEtagList(undefined)).toBeUndefined();
    expect(parseEtagList(' * ')).toEqual({ star: true, tags: [] });
    expect(parseEtagList('"a", W/"b" ,"c"')).toEqual({
      star: false,
      tags: [
        { weak: false, value: 'a' },
        { weak: true, value: 'b' },
        { weak: false, value: 'c' },
      ],
    });
    expect(parseEtagList('a, "b')).toEqual({ star: false, tags: [] });
  });
});

describe('evaluatePreconditions (RFC 9110 section 13.2.2, entity tags only)', () => {
  it('proceeds when nothing is asked', () => {
    expect(evaluatePreconditions(input({}))).toBe('proceed');
  });

  it('If-Match: strong comparison against the current tag; * needs a current representation', () => {
    expect(evaluatePreconditions(input({ ifMatch: '"a.1"' }))).toBe('proceed');
    expect(evaluatePreconditions(input({ ifMatch: '"x", "a.1"' }))).toBe('proceed');
    expect(evaluatePreconditions(input({ ifMatch: '"a.2"' }))).toBe('precondition-failed');
    expect(evaluatePreconditions(input({ ifMatch: 'W/"a.1"' }))).toBe('precondition-failed');
    expect(evaluatePreconditions(input({ ifMatch: '*' }))).toBe('proceed');
    expect(evaluatePreconditions(input({ ifMatch: '*', currentEtag: undefined }))).toBe(
      'precondition-failed',
    );
    expect(evaluatePreconditions(input({ ifMatch: '"a.1"', currentEtag: undefined }))).toBe(
      'precondition-failed',
    );
    expect(evaluatePreconditions(input({ ifMatch: 'garbage' }))).toBe('precondition-failed');
  });

  it('If-None-Match: * means create-if-absent for a write and not-modified for a read', () => {
    expect(evaluatePreconditions(input({ ifNoneMatch: '*', currentEtag: undefined }))).toBe('proceed');
    expect(evaluatePreconditions(input({ ifNoneMatch: '*' }))).toBe('precondition-failed');
    expect(evaluatePreconditions(input({ method: 'GET', ifNoneMatch: '"a.1"' }))).toBe('not-modified');
    expect(evaluatePreconditions(input({ method: 'HEAD', ifNoneMatch: 'W/"a.1"' }))).toBe('not-modified');
    expect(evaluatePreconditions(input({ method: 'GET', ifNoneMatch: '"b.1"' }))).toBe('proceed');
    expect(evaluatePreconditions(input({ method: 'DELETE', ifNoneMatch: '"a.1"' }))).toBe(
      'precondition-failed',
    );
  });

  it('applies If-Match first', () => {
    expect(evaluatePreconditions(input({ method: 'GET', ifMatch: '"zzz"', ifNoneMatch: '"a.1"' }))).toBe(
      'precondition-failed',
    );
  });
});

describe('pagination', () => {
  const limits = { defaultLimit: DEFAULT_PAGE_LIMIT, maxLimit: 50 };
  const read = (query: string, scope = '/space/s/c/') =>
    readPageRequest(new URLSearchParams(query), scope, limits);

  it('defaults, clamps and validates the limit', () => {
    expect(read('')).toEqual({ limit: DEFAULT_PAGE_LIMIT });
    expect(read('limit=7')).toEqual({ limit: 7 });
    expect(read('limit=500').limit).toBe(50);
    // however many digits: an oversized limit is clamped, never rejected
    for (const huge of ['1000000000', '99999999999999999999999', '0000000000000000000009']) {
      expect(read(`limit=${huge}`).limit).toBe(huge.startsWith('0') ? 9 : 50);
    }

    for (const bad of ['limit=0', 'limit=000', 'limit=-3', 'limit=abc', 'limit=1.5', 'limit=', 'limit=1e3']) {
      expect(() => read(bad)).toThrow(PwsError);
    }
  });

  it('round-trips a cursor and ties it to the list it was issued for', () => {
    const cursor = encodeCursor('/space/s/c/', 'item-9');
    expect(read(`cursor=${cursor}`).after).toBe('item-9');
    expect(() => read(`cursor=${cursor}`, '/space/s/other/')).toThrow(/different list/);
    for (const bad of [
      '',
      'not base64!',
      Buffer.from('{}').toString('base64url'),
      Buffer.from('[1]').toString('base64url'),
      Buffer.from('nope').toString('base64url'),
    ]) {
      expect(() => read(`cursor=${bad}`)).toThrow(PwsError);
    }
  });

  it('builds a next link that keeps the limit and carries the cursor', () => {
    const link = nextLink('/space/s/c/', 2, 'last');
    expect(link.startsWith('/space/s/c/?limit=2&cursor=')).toBe(true);
    const query = new URLSearchParams(link.split('?')[1]);
    expect(read(query.toString()).after).toBe('last');
  });
});

describe('problems', () => {
  it('renders RFC 9457 problems with the registry type URI', () => {
    const error = new PwsError('id-conflict', 'taken');
    expect(error.status).toBe(409);
    expect(error.toProblem()).toEqual({
      type: 'https://w3id.org/pws#id-conflict',
      title: 'Identifier already in use',
      status: 409,
      detail: 'taken',
    });
  });

  it('gives the merged not-found one fixed body whatever the cause', () => {
    expect(JSON.stringify(notFound().toProblem())).toBe(JSON.stringify(notFound().toProblem()));
    expect(notFound().status).toBe(404);
  });

  it('answers a missing method with a 405 and an Allow header, as about:blank', () => {
    expect(methodNotAllowed(['GET', 'HEAD'])).toEqual({
      status: 405,
      headers: { allow: 'GET, HEAD' },
      body: { type: 'about:blank', title: 'Method Not Allowed', status: 405 },
    });
  });
});
