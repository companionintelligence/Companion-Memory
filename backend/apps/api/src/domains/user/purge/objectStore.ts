/**
 * The purge's view of the object store.
 *
 * `ci.files` rows carry a `(bucket, key)` pair; the bytes themselves live in
 * Minio/S3 and no code in this repository has ever deleted one. Purging only the
 * rows would leave every photo, recording and document the account uploaded
 * sitting in the bucket, unreferenced and undeletable — which is exactly the
 * kind of thing an "account deletion deletes your data" claim is read to cover.
 *
 * Kept behind an interface so the user domain does not depend on the files
 * domain, and so tests can assert what would have been deleted without a bucket.
 */
export interface PurgeObjectStore {
  /** Delete the given keys from a bucket. Must tolerate keys that do not exist. */
  deleteObjects(bucket: string, keys: string[]): Promise<void>;
}

export const PURGE_OBJECT_STORE = Symbol('PURGE_OBJECT_STORE');

/** Anything that can run parameterised SQL: a `DataSource` or a `QueryRunner`. */
interface SqlExecutor {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * Objects owned solely by this account. The `NOT EXISTS` clause matters: file
 * rows are deduplicated on content, so two accounts can point at one object.
 * Deleting the bytes out from under the other account would be a data-loss bug
 * caused by a privacy feature.
 */
const SOLE_OWNED_OBJECTS_SQL = `
  SELECT DISTINCT f.bucket AS bucket, f.key AS key
  FROM ci.files f
  WHERE f.user_id = $1
    AND f.bucket IS NOT NULL
    AND f.key IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM ci.files o
      WHERE o.bucket = f.bucket AND o.key = f.key AND o.user_id <> $1
    )
  ORDER BY f.bucket, f.key
  LIMIT $2 OFFSET $3
`;

/**
 * Delete from the object store every object only this account's `ci.files`
 * rows point at, and return how many went. Shared by the 30-day purge and the
 * immediate account delete, so the rule that protects another account's
 * deduplicated file lives in one place.
 *
 * Call it while the rows are still there. Paged with `LIMIT`/`OFFSET` rather
 * than a keyset because the rows are not being deleted yet, so the result set
 * is stable for the length of the loop.
 */
export async function deleteSoleOwnedObjects(
  executor: SqlExecutor,
  store: PurgeObjectStore,
  userId: string,
  pageSize: number,
): Promise<number> {
  let offset = 0;
  let deleted = 0;

  for (;;) {
    const page = await readSoleOwnedPage(executor, userId, pageSize, offset);

    if (page.length === 0) {
      return deleted;
    }

    deleted += await deleteStoredObjects(store, page);
    offset += page.length;
  }
}

/** A stored object: where the bytes behind a `ci.files` row live. */
export interface StoredObject {
  bucket: string;
  key: string;
}

/**
 * The objects {@link deleteSoleOwnedObjects} would delete, read without
 * deleting any. For a caller that deletes the rows first, in a transaction, and
 * the bytes only once nothing can roll those rows back: it has to read the keys
 * while the rows that name them are still there.
 */
export async function listSoleOwnedObjects(
  executor: SqlExecutor,
  userId: string,
  pageSize: number,
): Promise<StoredObject[]> {
  const objects: StoredObject[] = [];

  for (;;) {
    const page = await readSoleOwnedPage(executor, userId, pageSize, objects.length);

    if (page.length === 0) {
      return objects;
    }

    objects.push(...page);
  }
}

/** Delete these objects, one `deleteObjects` call per bucket per page, and return how many went. */
export async function deleteStoredObjects(
  store: PurgeObjectStore,
  objects: readonly StoredObject[],
  pageSize = objects.length,
): Promise<number> {
  const size = Math.max(pageSize, 1);
  let deleted = 0;

  for (let start = 0; start < objects.length; start += size) {
    const byBucket = new Map<string, string[]>();

    for (const object of objects.slice(start, start + size)) {
      const keys = byBucket.get(object.bucket);

      if (keys) {
        keys.push(object.key);
      } else {
        byBucket.set(object.bucket, [object.key]);
      }
    }

    for (const [bucket, keys] of byBucket) {
      await store.deleteObjects(bucket, keys);
      deleted += keys.length;
    }
  }

  return deleted;
}

async function readSoleOwnedPage(
  executor: SqlExecutor,
  userId: string,
  pageSize: number,
  offset: number,
): Promise<StoredObject[]> {
  return (await executor.query(SOLE_OWNED_OBJECTS_SQL, [userId, pageSize, offset])) as StoredObject[];
}
