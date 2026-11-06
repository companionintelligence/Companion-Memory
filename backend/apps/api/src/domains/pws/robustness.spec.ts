import { World, alice, app, bob } from './__tests__/testKit';
import { parseAuthorizationSignature } from './httpSignature';
import { HttpSignatureError } from './httpSignature';
import { parseRoute, PwsUrls } from './routes';
import { ZcapError, parseCapabilityInvocation } from './zcap';
import type { DelegatedZcap } from './zcap';

/** A small seeded PRNG (mulberry32) so a failure is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'abcXYZ019-_.~%/?&=# :;,"\\<>{}[]()*\u00e9\u4e2d\ud83d\ude00\t';

function junk(random: () => number, max = 40): string {
  const length = Math.floor(random() * max);
  const chars = [...ALPHABET];
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(random() * chars.length)];
  }
  return out;
}

function mutate(random: () => number, value: string): string {
  const chars = [...value];
  const edits = 1 + Math.floor(random() * 3);
  for (let i = 0; i < edits && chars.length > 0; i += 1) {
    const at = Math.floor(random() * chars.length);
    const roll = random();
    if (roll < 0.4) {
      chars.splice(at, 1);
    } else if (roll < 0.7) {
      chars[at] = [...ALPHABET][Math.floor(random() * [...ALPHABET].length)] as string;
    } else {
      chars.splice(at, 0, ...junk(random, 4));
    }
  }
  return chars.join('');
}

describe('parsers never throw anything but their own error', () => {
  it('parseRoute is total', () => {
    const urls = new PwsUrls('https://example.com/pws/');
    const random = prng(1);
    for (let i = 0; i < 3000; i += 1) {
      const path = junk(random, 60);
      const route = parseRoute(urls, `https://example.com/pws/${path}`);
      expect(typeof route.kind).toBe('string');
    }
  });

  it('parseAuthorizationSignature throws only HttpSignatureError', () => {
    const random = prng(2);
    const valid =
      'Signature keyId="did:key:z6Mk#z6Mk",headers="(key-id) (created) host",signature="AAAA",created="1",expires="2"';
    for (let i = 0; i < 3000; i += 1) {
      const value = i % 2 === 0 ? mutate(random, valid) : junk(random, 80);
      try {
        parseAuthorizationSignature(value);
      } catch (error) {
        expect(error).toBeInstanceOf(HttpSignatureError);
      }
    }
  });

  it('parseCapabilityInvocation throws only ZcapError', () => {
    const random = prng(3);
    const valid = 'zcap id="urn:zcap:root:https%3A%2F%2Fexample.com%2F",action="GET"';
    for (let i = 0; i < 3000; i += 1) {
      const value = i % 2 === 0 ? mutate(random, valid) : junk(random, 80);
      try {
        parseCapabilityInvocation(value);
      } catch (error) {
        expect(error).toBeInstanceOf(ZcapError);
      }
    }
  });
});

describe('the handler never answers 5xx, whatever it is sent', () => {
  it('survives mutated credentials, paths, methods and bodies', async () => {
    const w = new World({
      onError: (error) => {
        throw error;
      },
    });
    await w.createSpace(alice, 's');
    await w.createCollection(alice, 's', 'c');
    await w.putResource(alice, 's', 'c', 'r', { a: 1 });

    const signed = await w.send({ method: 'GET', path: 's' });
    expect(signed.status).toBe(404);
    const { signRequest } = await import('./httpSignature');
    const { formatCapabilityInvocation, rootZcapId } = await import('./zcap');
    const url = w.url('space/s/c/r');
    const good = await signRequest({
      method: 'GET',
      url,
      headers: {},
      signer: alice.signer,
      created: Math.floor(w.now.getTime() / 1000),
      capabilityInvocation: formatCapabilityInvocation({ rootId: rootZcapId(url), action: 'GET' }),
    });
    expect((await w.handler.handle({ method: 'GET', url, headers: good })).status).toBe(200);

    const random = prng(4);
    const methods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE', 'get', ''];
    const names = Object.keys(good);
    const statuses = new Set<number>();
    for (let i = 0; i < 1500; i += 1) {
      const headers = { ...good };
      const name = names[Math.floor(random() * names.length)] as string;
      if (random() < 0.15) {
        delete headers[name];
      } else {
        headers[name] = mutate(random, headers[name] as string);
      }
      const target = random() < 0.3 ? `${w.url('')}${junk(random, 30)}` : url;
      let response;
      try {
        response = await w.handler.handle({
          method: methods[Math.floor(random() * methods.length)] as string,
          url: target,
          headers,
          ...(random() < 0.3 ? { body: new TextEncoder().encode(junk(random, 20)) } : {}),
        });
      } catch (error) {
        throw new Error(`the handler threw for ${String(i)}: ${String(error)}`);
      }
      statuses.add(response.status);
      expect(response.status).toBeLessThan(500);
      if (response.status >= 400 && response.body) {
        const problem = JSON.parse(new TextDecoder().decode(response.body)) as {
          type?: string;
          title?: string;
        };
        expect(typeof problem.type).toBe('string');
      }
    }
    // the corpus reaches more than one outcome, or it proves nothing
    expect(statuses.size).toBeGreaterThan(3);
  });
});

describe('writes are atomic with their preconditions', () => {
  it('lets exactly one of two concurrent create-if-absent writes win', async () => {
    const w = new World();
    await w.createSpace(alice, 's');
    await w.createCollection(alice, 's', 'c');
    const attempt = (n: number) =>
      w.send({
        method: 'PUT',
        path: 'space/s/c/race',
        as: alice,
        root: w.spaceUrl('s'),
        headers: { 'if-none-match': '*' },
        json: { n },
      });
    const results = await Promise.all([attempt(1), attempt(2), attempt(3), attempt(4)]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 412, 412, 412]);
  });

  it('lets exactly one of two concurrent Space creations of the same id win', async () => {
    const w = new World();
    const attempt = (who: typeof alice) =>
      w.send({ method: 'POST', path: 'spaces/', as: who, json: { id: 'taken', controller: who.did } });
    const results = await Promise.all([attempt(alice), attempt(bob)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = results.find((r) => r.status === 201);
    expect(winner?.json.controller).toBeDefined();
  });

  it('lets exactly one of two concurrent If-Match updates win', async () => {
    const w = new World();
    await w.createSpace(alice, 's');
    await w.createCollection(alice, 's', 'c');
    const etag = (await w.putResource(alice, 's', 'c', 'doc', { v: 0 })).header('etag') as string;
    const update = (v: number) =>
      w.send({
        method: 'PUT',
        path: 'space/s/c/doc',
        as: alice,
        root: w.spaceUrl('s'),
        headers: { 'if-match': etag },
        json: { v },
      });
    const results = await Promise.all([update(1), update(2), update(3)]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 412, 412]);
  });
});

describe('the handler never answers 5xx to a structurally mutated capability', () => {
  type Path = Array<string | number>;

  function paths(value: unknown, prefix: Path = [], out: Path[] = []): Path[] {
    out.push(prefix);
    if (Array.isArray(value)) {
      value.forEach((item, index) => paths(item, [...prefix, index], out));
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        paths(item, [...prefix, key], out);
      }
    }
    return out;
  }

  function edit(root: unknown, path: Path, random: () => number): unknown {
    if (path.length === 0) {
      return root;
    }
    const clone = structuredClone(root) as Record<string | number, unknown>;
    let node = clone;
    for (const step of path.slice(0, -1)) {
      node = node[step] as Record<string | number, unknown>;
    }
    const last = path[path.length - 1] as string | number;
    const replacements: unknown[] = [null, 5, true, [], {}, 'x', [null], { id: null }];
    if (random() < 0.25) {
      if (Array.isArray(node)) {
        node.splice(Number(last), 1);
      } else {
        delete node[last];
      }
    } else {
      node[last] = replacements[Math.floor(random() * replacements.length)];
    }
    return clone;
  }

  it('survives 800 edits of a three-level embedded capability, for an existing and an absent target', async () => {
    const errors: unknown[] = [];
    const w = new World({ onError: (e) => errors.push(e) });
    await w.createSpace(alice, 'sp');
    await w.createCollection(alice, 'sp', 'c');
    await w.putResource(alice, 'sp', 'c', 'r', { n: 1 });
    const g1 = await w.delegate({
      from: alice,
      to: app,
      spaceId: 'sp',
      target: w.url('space/sp/c/'),
      actions: ['GET'],
    });
    const g2 = await w.delegate({
      from: app,
      to: bob,
      parent: g1,
      target: w.url('space/sp/c/r'),
      actions: ['GET'],
    });
    const all = paths(g2);
    const random = prng(11);
    for (let i = 0; i < 800; i += 1) {
      const mutated = edit(g2, all[Math.floor(random() * all.length)] as Path, random) as DelegatedZcap;
      const path = i % 2 === 0 ? 'space/sp/c/r' : 'space/ghost/c/r';
      const res = await w.send({ method: 'GET', path, as: bob, via: mutated });
      expect([i, res.status < 500]).toEqual([i, true]);
    }
    expect(errors).toEqual([]);
  });
});
