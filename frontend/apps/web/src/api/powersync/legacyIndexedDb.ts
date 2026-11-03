/**
 * The IndexedDB database earlier builds of this app left behind, and nothing else.
 *
 * Until 2026-10-20 the web app synced its PowerSync replica into WASQLite over
 * IndexedDB (`IDBBatchAtomicVFS.create(dbFilename, …)`, so the IndexedDB database
 * carries the SQLite file's name). Until 2026-10-26 every signed-in load still
 * opened that database — in a browser to wipe it, on a phone as a placeholder the
 * encrypted adapter then replaced — which left an empty `ci-powersync.db` entry in
 * every profile and loaded the SQLite worker for nothing. The provider no longer
 * opens a web database at all; this deletes what those builds left, once per load,
 * without loading any of the sync engine.
 */

/** The `dbFilename` every earlier build passed to the web SDK, hence the IndexedDB name. */
export const LEGACY_INDEXEDDB_NAME = 'ci-powersync.db';

/** Anything the web SDK or its VFS stored under the same stem (none known today; cheap to cover). */
const LEGACY_NAME_PREFIX = 'ci-powersync';

/**
 * Deletes the legacy database(s). Resolves with the names that the browser
 * listed before deletion — empty where nothing was there, or where the browser
 * cannot list databases (Firefox before 126; the known name is still deleted,
 * which is a no-op when it does not exist). Never throws: a profile that blocks
 * IndexedDB, or another tab holding the database open, must not take the app
 * down with it.
 */
export async function purgeLegacyIndexedDbReplica(): Promise<string[]> {
  const idb = typeof indexedDB === 'undefined' ? undefined : indexedDB;

  if (!idb) {
    return [];
  }

  let present: string[] = [];

  try {
    const listed = typeof idb.databases === 'function' ? await idb.databases() : [];

    present = listed
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === 'string' && name.startsWith(LEGACY_NAME_PREFIX));
  } catch {
    // Listing is optional; the known name below is deleted regardless.
  }

  const targets = new Set([LEGACY_INDEXEDDB_NAME, ...present]);

  await Promise.all([...targets].map((name) => deleteDatabase(idb, name)));

  return present;
}

function deleteDatabase(idb: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;

    try {
      request = idb.deleteDatabase(name);
    } catch {
      resolve();

      return;
    }

    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    // Another tab still has it open: the deletion completes when that tab closes
    // it. Nothing here waits on that.
    request.onblocked = () => resolve();
  });
}
