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
