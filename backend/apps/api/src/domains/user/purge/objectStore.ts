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
