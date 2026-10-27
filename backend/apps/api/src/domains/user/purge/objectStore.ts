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
 * How long one `deleteObjects` call may take before the purge gives up on it. The
 * S3 client sets no timeout of its own, and a purge waiting on a store that never
 * answers holds its account's advisory lock and the hourly cron's slot for good.
 * The call is not cancelled, only no longer waited for: the purge fails, keeps the
 * rows (so the keys can be found again), and the next run deletes the same keys,
 * which the store tolerates. The same bound a file purge uses
 * (`STORED_OBJECT_DELETE_DEADLINE_MS` in `memory/services/filePurge.ts`).
 */
export const OBJECT_DELETE_DEADLINE_MS = 60_000;

/**
 * Objects owned solely by this account. The `NOT EXISTS` clause matters: file
 * rows are deduplicated on content, so two accounts can point at one object.
 * Deleting the bytes out from under the other account would be a data-loss bug
 * caused by a privacy feature.
 *
 * Paged by key (`(bucket, key) > (last page's last)`, compared as text in the
 * "C" collation so the order and the comparison agree; `key` is a uuid), not
 * `OFFSET`, which read every earlier page again for each new one: quadratic in
 * the account's files.
 */
const SOLE_OWNED_OBJECTS_SQL = `
  SELECT DISTINCT f.bucket::text COLLATE "C" AS bucket, f.key::text COLLATE "C" AS key
  FROM ci.files f
  WHERE f.user_id = $1
    AND f.bucket IS NOT NULL
    AND f.key IS NOT NULL
    AND (f.bucket::text COLLATE "C", f.key::text COLLATE "C") > ($3::text, $4::text)
    AND NOT EXISTS (
      SELECT 1 FROM ci.files o
      WHERE o.bucket = f.bucket AND o.key = f.key AND o.user_id <> $1
    )
  ORDER BY 1, 2
  LIMIT $2
`;

/**
 * Delete from the object store every object only this account's `ci.files`
 * rows point at, and return how many went.
 *
 * Call it while the rows are still there: the rows are how the keys are found.
 * A purge interrupted after this and before the rows go finds the same keys again
 * and deletes them again, which the store tolerates; the other order would lose
 * the keys and strand the bytes.
 */
export async function deleteSoleOwnedObjects(
  executor: SqlExecutor,
  store: PurgeObjectStore,
  userId: string,
  pageSize: number,
  deadlineMs: number = OBJECT_DELETE_DEADLINE_MS,
): Promise<number> {
  let after: StoredObject = { bucket: '', key: '' };
  let deleted = 0;

  for (;;) {
    const page = (await executor.query(SOLE_OWNED_OBJECTS_SQL, [
      userId,
      pageSize,
      after.bucket,
      after.key,
    ])) as StoredObject[];

    if (page.length === 0) {
      return deleted;
    }

    deleted += await deleteStoredObjects(store, page, deadlineMs);
    after = page[page.length - 1];
  }
}

/** A stored object: where the bytes behind a `ci.files` row live. */
export interface StoredObject {
  bucket: string;
  key: string;
}

/** Delete these objects, one `deleteObjects` call per bucket, and return how many went. */
async function deleteStoredObjects(
  store: PurgeObjectStore,
  objects: readonly StoredObject[],
  deadlineMs: number,
): Promise<number> {
  const byBucket = new Map<string, string[]>();

  for (const object of objects) {
    const keys = byBucket.get(object.bucket);

    if (keys) {
      keys.push(object.key);
    } else {
      byBucket.set(object.bucket, [object.key]);
    }
  }

  let deleted = 0;

  for (const [bucket, keys] of byBucket) {
    await withDeadline(store.deleteObjects(bucket, keys), deadlineMs);
    deleted += keys.length;
  }

  return deleted;
}

/** `work`, or a rejection once `ms` have passed without it settling. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`The object store did not answer within ${ms / 1000} s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
