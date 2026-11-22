import { newValidator } from './models';
import type { ResourceRecord } from './models';
import { MemoryPwsStore } from './store';

function resource(id: string, bytes: Uint8Array): ResourceRecord {
  return {
    spaceId: 's',
    collectionId: 'c',
    id,
    contentType: 'application/json',
    bytes,
    createdBy: 'did:key:z6MkTest',
    createdAt: '2026-11-05T12:00:00.000Z',
    stamp: { updatedAt: '2026-11-05T12:00:00.000Z', updatedAtCounter: 0, originId: 'test' },
    validator: newValidator(),
    metaValidator: newValidator(),
  };
}

/** A request body as `nodeListener` builds it: `Buffer.concat` of under 4 KiB is a view into Node's shared 8 KiB pool. */
const pooledBody = (text: string): Uint8Array => Buffer.concat([Buffer.from(text)]);

describe('MemoryPwsStore: Resource bytes', () => {
  it('is exercised with a body that really is a view into a larger buffer', () => {
    const body = pooledBody('{"a":1}');
    expect(body.buffer.byteLength).toBeGreaterThan(body.byteLength);
  });

  it('keeps, returns and lists the bytes in exact-size buffers, not in the pool behind the request body', async () => {
    const store = new MemoryPwsStore();
    await store.transaction((tx) => tx.putResource(resource('r1', pooledBody('{"a":1}'))));
    await store.transaction(async (tx) => {
      const one = await tx.getResource('s', 'c', 'r1');
      const page = await tx.listResources('s', 'c', { limit: 10 });
      for (const r of [one!, ...page.items]) {
        expect(r.bytes.buffer.byteLength).toBe(r.bytes.byteLength);
      }
    });
    // What the store holds, not just what it hands out.
    const held = (store as unknown as { resources: Map<string, ResourceRecord> }).resources;
    expect(held.size).toBe(1);
    for (const r of held.values()) {
      expect(r.bytes.buffer.byteLength).toBe(r.bytes.byteLength);
    }
  });

  it('still isolates the store from callers: a submitted or a returned record can be mutated freely', async () => {
    const store = new MemoryPwsStore();
    const submitted = resource('r1', pooledBody('{"a":1}'));
    await store.transaction((tx) => tx.putResource(submitted));
    submitted.bytes[2] = 0x58;
    await store.transaction(async (tx) => {
      const first = await tx.getResource('s', 'c', 'r1');
      expect(new TextDecoder().decode(first!.bytes)).toBe('{"a":1}');
      first!.bytes[2] = 0x59;
      const second = await tx.getResource('s', 'c', 'r1');
      expect(new TextDecoder().decode(second!.bytes)).toBe('{"a":1}');
    });
  });
});

describe('MemoryPwsStore: limits', () => {
  const bytes = (n: number): Uint8Array => new Uint8Array(n);
  const put = (store: MemoryPwsStore, id: string, size: number) =>
    store.transaction((tx) => tx.putResource(resource(id, bytes(size))));
  const quota = expect.objectContaining({ kind: 'quota-exceeded', status: 507 });

  it('refuses a Resource that would take it past its byte ceiling', async () => {
    const store = new MemoryPwsStore({ maxBytes: 100, maxRecords: 1_000 });
    await put(store, 'r1', 60);

    await expect(put(store, 'r2', 50)).rejects.toEqual(quota);
    await expect(put(store, 'r2', 40)).resolves.toBeUndefined();
  });

  it('counts a rewrite by how much it grows, and always lets one shrink', async () => {
    const store = new MemoryPwsStore({ maxBytes: 100, maxRecords: 1_000 });
    await put(store, 'r1', 100);

    await expect(put(store, 'r1', 100)).resolves.toBeUndefined();
    await expect(put(store, 'r1', 101)).rejects.toEqual(quota);
    await expect(put(store, 'r1', 10)).resolves.toBeUndefined();
    await expect(put(store, 'r2', 90)).resolves.toBeUndefined();
  });

  it('gives the bytes back when a Resource, its Collection or its Space is deleted', async () => {
    const store = new MemoryPwsStore({ maxBytes: 100, maxRecords: 1_000 });
    await put(store, 'r1', 100);
    await store.transaction((tx) => tx.deleteResource('s', 'c', 'r1'));
    await put(store, 'r2', 100);
    await store.transaction((tx) => tx.deleteCollection('s', 'c'));
    // A Space is deleted through its Collections, so this one has its Collection record, as a real one does.
    await store.transaction((tx) => tx.putCollection({ spaceId: 's', id: 'c' } as never));
    await put(store, 'r3', 100);
    await store.transaction((tx) => tx.deleteSpace('s'));

    await expect(put(store, 'r4', 100)).resolves.toBeUndefined();
  });

  it('refuses a new record past its record ceiling, but not a rewrite of one it holds', async () => {
    const store = new MemoryPwsStore({ maxBytes: 1_000, maxRecords: 2 });
    await put(store, 'r1', 1);
    await put(store, 'r2', 1);

    await expect(put(store, 'r3', 1)).rejects.toEqual(quota);
    await expect(put(store, 'r1', 2)).resolves.toBeUndefined();
  });

  it('keeps working after a refused write', async () => {
    const store = new MemoryPwsStore({ maxBytes: 10, maxRecords: 1_000 });
    await expect(put(store, 'big', 11)).rejects.toEqual(quota);

    await expect(store.transaction((tx) => tx.getResource('s', 'c', 'big'))).resolves.toBeUndefined();
    await expect(put(store, 'small', 10)).resolves.toBeUndefined();
  });

  it('ships with ceilings that leave room for real use', () => {
    const limits = (new MemoryPwsStore() as unknown as { limits: { maxBytes: number; maxRecords: number } }).limits;

    expect(limits.maxBytes).toBe(256 * 1024 * 1024);
    expect(limits.maxRecords).toBe(100_000);
  });
});
