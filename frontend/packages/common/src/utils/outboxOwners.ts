import { buildApiUrl, getApiBaseUrl } from './apiBase';
import { fetchJson } from './fetchJson';
import { outboxOwnerStamp, reassignOutboxOwner } from './outbox';

/**
 * Which account each outbox owner stamp belonged to, so captures queued under an earlier key
 * can follow the same account to its new one.
 *
 * A stamp names the Memory origin and the API key (see {@link outboxOwnerStamp}), deliberately
 * not the account. When the key changes for the same account on the same Memory ("Sign out
 * everywhere", a password change, a re-pair), the rows queued under the old key no longer match
 * and would never be sent. Nothing in an old stamp says whose it was, and once its key is revoked
 * nobody can ask Memory. So the account is written down here while the key still works, the first
 * time a drain runs under it, and checked at every drain after that.
 *
 * Rows move only between stamps recorded for the same account id on the same origin, and the id
 * comes from Memory itself, asked with the key the stamp was made from. A row queued for one
 * account is never re-stamped for another, which is the rule the stamp exists for.
 *
 * Kept in the WebView's localStorage beside the paired origin (`apiBase.ts`): only the app's own
 * pages can write it, and it holds no secret, only fingerprints and an account id.
 */

const LEDGER_STORAGE_KEY = 'ci.outbox.owners.v1';

/** Enough for every key a phone holds in practice; the oldest go first past it. */
const MAX_LEDGER_ENTRIES = 32;

interface OwnerEntry {
  stamp: string;
  origin: string;
  account: string;
}

interface MeResponse {
  data?: { me?: { id?: unknown } | null } | null;
}

function ledgerStorage(): Storage | null {
  try {
    return (globalThis as { window?: { localStorage?: Storage } }).window?.localStorage ?? null;
  } catch {
    return null;
  }
}

function isOwnerEntry(value: unknown): value is OwnerEntry {
  const entry = value as Partial<OwnerEntry> | null;

  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.stamp === 'string' &&
    typeof entry.origin === 'string' &&
    typeof entry.account === 'string' &&
    entry.stamp.length > 0 &&
    entry.account.length > 0
  );
}

function readLedger(storage: Storage): OwnerEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(LEDGER_STORAGE_KEY) ?? '[]');

    return Array.isArray(parsed) ? parsed.filter(isOwnerEntry) : [];
  } catch {
    return [];
  }
}

function writeLedger(storage: Storage, entries: readonly OwnerEntry[]): void {
  try {
    storage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(entries.slice(-MAX_LEDGER_ENTRIES)));
  } catch {
    // Storage full or refused: the next drain asks again.
  }
}

/** The origin part of a stamp, as {@link outboxOwnerStamp} writes it. */
function stampOrigin(): string {
  return getApiBaseUrl() || 'same-origin';
}

/** The id of the account the current key signs in as, asked of Memory with that key. */
async function accountForCurrentKey(signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetchJson<MeResponse>(buildApiUrl('/api/graphql'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query OutboxOwnerAccount { me { id } }' }),
      signal,
    });
    const id = response?.data?.me?.id;

    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Record whose the current stamp is, and move rows queued under this account's earlier stamps
 * on this Memory onto it. Resolves with how many rows moved. Never throws: the drain goes ahead
 * either way, and whatever could not be done is tried again at the next one.
 *
 * Cheap after the first call for a key: Memory is asked only for a stamp not yet recorded, and
 * the sidecar only while earlier stamps of the same account are still on file.
 */
export async function adoptEarlierOutboxRows(signal?: AbortSignal): Promise<number> {
  const storage = ledgerStorage();
  const stamp = outboxOwnerStamp();

  if (!storage || !stamp) {
    return 0;
  }

  let ledger = readLedger(storage);
  let current = ledger.find((entry) => entry.stamp === stamp);

  if (!current) {
    const account = await accountForCurrentKey(signal);

    // The key changed while Memory was being asked: the answer is about a different stamp.
    if (!account || outboxOwnerStamp() !== stamp) {
      return 0;
    }

    current = { stamp, origin: stampOrigin(), account };
    ledger = [...readLedger(storage).filter((entry) => entry.stamp !== stamp), current];
    writeLedger(storage, ledger);
  }

  const { origin, account } = current;
  const earlier = ledger
    .filter((entry) => entry.stamp !== stamp && entry.origin === origin && entry.account === account)
    .map((entry) => entry.stamp);

  if (earlier.length === 0) {
    return 0;
  }

  const moved = await reassignOutboxOwner(earlier, stamp);

  if (!moved.ok) {
    return 0;
  }

  // Those keys are gone for good, and their rows now carry this stamp.
  const done = new Set(earlier);

  writeLedger(
    storage,
    readLedger(storage).filter((entry) => !done.has(entry.stamp)),
  );

  return moved.value;
}

/** Sign-out deletes every queued row, so there is nothing left for a recorded stamp to name. */
export function forgetOutboxOwners(): void {
  try {
    ledgerStorage()?.removeItem(LEDGER_STORAGE_KEY);
  } catch {
    // Nothing to forget.
  }
}
