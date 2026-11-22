/**
 * The storage seam of the PWS handler, and an in-memory implementation of it.
 *
 * Every operation runs inside `transaction()`, so the "authorize, then evaluate the precondition,
 * then write" sequence of the specification is atomic by construction: two writers cannot both
 * observe the same prior version and both succeed. The in-memory store serializes transactions
 * behind one queue. A database-backed store implements the same interface with row locks or a
 * serializable transaction; the handler is written so that is the only change it needs.
 *
 * Lists are ordered ascending by `id` (the default order of the specification's pagination
 * profile: stable and total, since ids are unique within their parent) and paged by a keyset
 * (`after`), never by offset.
 */
import type { CollectionRecord, PolicyDocument, PolicyScope, ResourceRecord, SpaceRecord } from './models';
import { PwsError } from './problems';

export interface ListOptions {
  /** Return only ids strictly greater than this one. */
  after?: string;
  limit: number;
}

export interface Page<T> {
  items: T[];
  /** More items follow `items` (the cursor for the next page is the last item's id). */
  hasMore: boolean;
}

export interface PwsTx {
  getSpace(id: string): Promise<SpaceRecord | undefined>;
  putSpace(space: SpaceRecord): Promise<void>;
  /** Removes the Space and everything beneath it: Collections, Resources and policies. */
  deleteSpace(id: string): Promise<void>;
  listSpaces(options: ListOptions & { controller?: string }): Promise<Page<SpaceRecord>>;
  countSpaces(controller?: string): Promise<number>;

  getCollection(spaceId: string, id: string): Promise<CollectionRecord | undefined>;
  putCollection(collection: CollectionRecord): Promise<void>;
  /** Removes the Collection with its Resources and policies. */
  deleteCollection(spaceId: string, id: string): Promise<void>;
  listCollections(spaceId: string, options: ListOptions): Promise<Page<CollectionRecord>>;
  countCollections(spaceId: string): Promise<number>;

  getResource(spaceId: string, collectionId: string, id: string): Promise<ResourceRecord | undefined>;
  putResource(resource: ResourceRecord): Promise<void>;
  deleteResource(spaceId: string, collectionId: string, id: string): Promise<boolean>;
  listResources(spaceId: string, collectionId: string, options: ListOptions): Promise<Page<ResourceRecord>>;
  countResources(spaceId: string, collectionId: string): Promise<number>;

  getPolicy(scope: PolicyScope): Promise<PolicyDocument | undefined>;
  putPolicy(scope: PolicyScope, policy: PolicyDocument): Promise<void>;
  deletePolicy(scope: PolicyScope): Promise<boolean>;
}

export interface PwsStore {
  transaction<T>(work: (tx: PwsTx) => Promise<T>): Promise<T>;
}

function policyKey(scope: PolicyScope): string {
  return `${scope.spaceId}\u0000${scope.collectionId ?? ''}\u0000${scope.resourceId ?? ''}`;
}

function page<T extends { id: string }>(items: T[], options: ListOptions): Page<T> {
  const sorted = items
    .filter((item) => options.after === undefined || item.id > options.after)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { items: sorted.slice(0, options.limit), hasMore: sorted.length > options.limit };
}

/**
 * Records are copied on the way in and out so a caller mutating one cannot reach into the store,
 * which a database-backed store gets for free.
 */
function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * A Resource is copied with its bytes in an exact-size buffer of their own. `structuredClone` of a typed array
 * copies the whole ArrayBuffer behind the view, and a request body under 4 KiB is a view into Node's shared
 * 8 KiB `Buffer` pool, so a plain clone keeps 8 KiB per small Resource (and copies 8 KiB again on every read).
 */
function copyResource(resource: ResourceRecord): ResourceRecord {
  const { bytes, ...rest } = resource;

  return { ...copy(rest), bytes: new Uint8Array(bytes) };
}

/**
 * How much an in-memory store may hold before it refuses writes.
 *
 * The store lives in the API process's own memory, and anyone can create a
 * Space: the request need only be signed by the controller its body names,
 * which can be a `did:key` minted for the purpose. Without a ceiling, `/pws/*`
 * (when the `pws.storage` flag is on) let any caller grow the process without
 * bound, 25 MiB a Resource, until it fell over.
 */
export interface MemoryPwsStoreLimits {
  /** Total Resource bytes. */
  maxBytes: number;
  /** Spaces, Collections, Resources and policies together. */
  maxRecords: number;
}

export const DEFAULT_MEMORY_PWS_STORE_LIMITS: MemoryPwsStoreLimits = {
  maxBytes: 256 * 1024 * 1024,
  maxRecords: 100_000,
};

export class MemoryPwsStore implements PwsStore {
  constructor(private readonly limits: MemoryPwsStoreLimits = DEFAULT_MEMORY_PWS_STORE_LIMITS) {}

  private bytes = 0;

  private readonly spaces = new Map<string, SpaceRecord>();

  private readonly collections = new Map<string, CollectionRecord>();

  private readonly resources = new Map<string, ResourceRecord>();

  private readonly policies = new Map<string, PolicyDocument>();

  private queue: Promise<unknown> = Promise.resolve();

  async transaction<T>(work: (tx: PwsTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => work(this.tx()));
    // The queue must survive a failed transaction.
    this.queue = run.catch(() => undefined);

    return run;
  }

  private tx(): PwsTx {
    const spaces = this.spaces;
    const collections = this.collections;
    const resources = this.resources;
    const policies = this.policies;
    const limits = this.limits;
    const records = (): number => spaces.size + collections.size + resources.size + policies.size;
    // A write that adds a record must fit the record ceiling; a write that replaces one always may.
    const roomForRecord = (map: Map<string, unknown>, key: string): void => {
      if (!map.has(key) && records() >= limits.maxRecords) {
        throw new PwsError('quota-exceeded', 'This storage is full.');
      }
    };

    const ckey = (spaceId: string, id: string): string => `${spaceId}\u0000${id}`;
    const rkey = (spaceId: string, collectionId: string, id: string): string =>
      `${spaceId}\u0000${collectionId}\u0000${id}`;
    const inCollection = (spaceId: string, collectionId: string): ResourceRecord[] =>
      [...resources.values()].filter((r) => r.spaceId === spaceId && r.collectionId === collectionId);

    const dropResource = (key: string): boolean => {
      const existing = resources.get(key);
      if (existing === undefined) {
        return false;
      }

      this.bytes -= existing.bytes.byteLength;

      return resources.delete(key);
    };

    const dropCollection = (spaceId: string, id: string): void => {
      collections.delete(ckey(spaceId, id));
      for (const r of inCollection(spaceId, id)) {
        dropResource(rkey(spaceId, id, r.id));
        policies.delete(policyKey({ spaceId, collectionId: id, resourceId: r.id }));
      }

      policies.delete(policyKey({ spaceId, collectionId: id }));
    };

    return {
      getSpace: async (id) => copyOrUndefined(spaces.get(id)),
      putSpace: async (space) => {
        roomForRecord(spaces, space.id);
        spaces.set(space.id, copy(space));
      },
      deleteSpace: async (id) => {
        for (const c of [...collections.values()].filter((c) => c.spaceId === id)) {
          dropCollection(id, c.id);
        }

        policies.delete(policyKey({ spaceId: id }));
        spaces.delete(id);
      },
      listSpaces: async ({ controller, ...options }) =>
        copy(
          page(
            [...spaces.values()].filter((s) => controller === undefined || s.controller === controller),
            options,
          ),
        ),
      countSpaces: async (controller) =>
        [...spaces.values()].filter((s) => controller === undefined || s.controller === controller).length,

      getCollection: async (spaceId, id) => copyOrUndefined(collections.get(ckey(spaceId, id))),
      putCollection: async (collection) => {
        const key = ckey(collection.spaceId, collection.id);
        roomForRecord(collections, key);
        collections.set(key, copy(collection));
      },
      deleteCollection: async (spaceId, id) => dropCollection(spaceId, id),
      listCollections: async (spaceId, options) =>
        copy(
          page(
            [...collections.values()].filter((c) => c.spaceId === spaceId),
            options,
          ),
        ),
      countCollections: async (spaceId) =>
        [...collections.values()].filter((c) => c.spaceId === spaceId).length,

      getResource: async (spaceId, collectionId, id) => {
        const stored = resources.get(rkey(spaceId, collectionId, id));

        return stored === undefined ? undefined : copyResource(stored);
      },
      putResource: async (resource) => {
        const key = rkey(resource.spaceId, resource.collectionId, resource.id);
        roomForRecord(resources, key);
        const growth = resource.bytes.byteLength - (resources.get(key)?.bytes.byteLength ?? 0);
        // Shrinking or same-size rewrites always fit, so a full store can still be tidied.
        if (growth > 0 && this.bytes + growth > limits.maxBytes) {
          throw new PwsError('quota-exceeded', 'This storage is full.');
        }

        resources.set(key, copyResource(resource));
        this.bytes += growth;
      },
      deleteResource: async (spaceId, collectionId, id) => {
        policies.delete(policyKey({ spaceId, collectionId, resourceId: id }));

        return dropResource(rkey(spaceId, collectionId, id));
      },
      listResources: async (spaceId, collectionId, options) => {
        const { items, hasMore } = page(inCollection(spaceId, collectionId), options);

        return { items: items.map(copyResource), hasMore };
      },
      countResources: async (spaceId, collectionId) => inCollection(spaceId, collectionId).length,

      getPolicy: async (scope) => copyOrUndefined(policies.get(policyKey(scope))),
      putPolicy: async (scope, policy) => {
        roomForRecord(policies, policyKey(scope));
        policies.set(policyKey(scope), copy(policy));
      },
      deletePolicy: async (scope) => policies.delete(policyKey(scope)),
    };
  }
}

function copyOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : copy(value);
}
