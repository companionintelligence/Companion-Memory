/**
 * Properties the threat table of `PORTABLE-WEB-SPACES.md` (CI-Engineering) names and that no other spec
 * exercised until a review planted a defect in each and every test stayed green: the current-key-set rule,
 * a link delegated before its parent, the JSON body cap, and two concurrent claimants of one unique value.
 */
import { World, alice, app, carol } from './__tests__/testKit';
import { didKeyMethod } from './keys';
import type { DidMethodSupport } from './keys';
import { delegateCapability } from './zcap';
import type { DelegatedZcap } from './zcap';

const S = 'space-1';
const C = 'docs';

async function world(config: ConstructorParameters<typeof World>[0] = {}): Promise<World> {
  const w = new World(config);
  await w.createSpace(alice, S);
  await w.createCollection(alice, S, C);
  await w.putResource(alice, S, C, 'a', { n: 'a' });

  return w;
}

/** `did:key`, except that a test can hide a key from one verification relationship between requests. */
function editableKeyMethod() {
  const hidden = new Set<string>();
  const method: DidMethodSupport = {
    method: 'key',
    resolve: async (did) => {
      const doc = await didKeyMethod.resolve(did);
      if (!doc) {
        return doc;
      }

      return {
        ...doc,
        capabilityInvocation: hidden.has(`${did}|capabilityInvocation`) ? [] : doc.capabilityInvocation,
        capabilityDelegation: hidden.has(`${did}|capabilityDelegation`) ? [] : doc.capabilityDelegation,
      };
    },
  };

  return {
    method,
    hide: (did: string, relationship: string) => void hidden.add(`${did}|${relationship}`),
    show: (did: string, relationship: string) => void hidden.delete(`${did}|${relationship}`),
  };
}

describe('the key must be listed for the right relationship, in the DID document as it is now', () => {
  it('stops invoking when it leaves capabilityInvocation, and works again when listed again', async () => {
    const keys = editableKeyMethod();
    const w = await world({ didMethods: [keys.method] });
    const get = () => w.send({ method: 'GET', path: `space/${S}/${C}/a`, as: alice, root: w.spaceUrl(S) });
    expect((await get()).status).toBe(200);
    keys.hide(alice.did, 'capabilityInvocation');
    const refused = await get();
    expect(refused.status).toBe(400);
    expect(refused.type).toBe('invalid-authorization-header');
    keys.show(alice.did, 'capabilityInvocation');
    expect((await get()).status).toBe(200);
  });

  it('is per relationship, and removing the delegation key withdraws what it delegated', async () => {
    const keys = editableKeyMethod();
    const w = await world({ didMethods: [keys.method] });
    const grant = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['GET'],
    });
    const read = () => w.send({ method: 'GET', path: `space/${S}/${C}/a`, as: app, via: grant });
    expect((await read()).status).toBe(200);
    keys.hide(alice.did, 'capabilityInvocation'); // the delegator may no longer invoke, but may still delegate
    expect((await read()).status).toBe(200);
    keys.hide(alice.did, 'capabilityDelegation'); // the key is gone for delegation: its grants stop, no revocation list
    expect((await read()).status).toBe(404);
    keys.show(alice.did, 'capabilityDelegation');
    expect((await read()).status).toBe(200);
  });
});

describe('a link delegated before its parent', () => {
  it('is refused, while a link made at the same instant is accepted', async () => {
    const w = await world();
    const first = await w.delegate({
      from: alice,
      to: app,
      spaceId: S,
      target: w.url(`space/${S}/${C}/`),
      actions: ['GET'],
      expiresInSeconds: 3600,
    });
    const child = (createdOffsetSeconds: number): Promise<DelegatedZcap> =>
      delegateCapability({
        parent: first,
        signer: app.signer,
        controller: carol.did,
        invocationTarget: w.url(`space/${S}/${C}/a`),
        allowedAction: ['GET'],
        expires: w.iso(1800),
        created: w.iso(createdOffsetSeconds),
      });
    const read = (grant: DelegatedZcap) =>
      w.send({ method: 'GET', path: `space/${S}/${C}/a`, as: carol, via: grant });
    expect((await read(await child(0))).status).toBe(200);
    expect((await read(await child(-60))).status).toBe(404);
  });
});

describe('the JSON body cap', () => {
  it('refuses a JSON body over maxJsonBytes with 413 and accepts one under it', async () => {
    const w = new World({ maxJsonBytes: 200 });
    const create = (id: string, name: string) =>
      w.send({ method: 'POST', path: 'spaces/', as: alice, json: { id, name, controller: alice.did } });
    expect((await create('small', 'n')).status).toBe(201);
    const big = await create('big', 'x'.repeat(300));
    expect(big.status).toBe(413);
    expect(big.type).toBe('payload-too-large');
  });
});

describe('two concurrent claimants of one unique index value', () => {
  it('lets exactly one win', async () => {
    const w = await world();
    await w.createCollection(alice, S, 'posts', { plaintext: { indexes: [{ name: 'slug', unique: true }] } });
    const claim = (id: string) =>
      w.send({
        method: 'PUT',
        path: `space/${S}/posts/${id}`,
        as: alice,
        root: w.spaceUrl(S),
        json: { slug: 'same' },
      });
    const results = await Promise.all([claim('one'), claim('two'), claim('three')]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409, 409]);
  });
});
