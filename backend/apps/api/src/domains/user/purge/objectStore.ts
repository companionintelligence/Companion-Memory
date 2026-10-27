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
    const page = (await executor.query(SOLE_OWNED_OBJECTS_SQL, [userId, pageSize, offset])) as Array<{
      bucket: string;
      key: string;
    }>;

    if (page.length === 0) {
      return deleted;
    }

    const byBucket = new Map<string, string[]>();

    for (const object of page) {
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

    offset += page.length;
  }
}
