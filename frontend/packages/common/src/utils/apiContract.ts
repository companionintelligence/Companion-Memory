/**
 * What this app speaks, and the oldest Memory server it still accepts.
 *
 * Independent of {@link API_VERSION} on the server. Bump `MIN_SERVER_CONTRACT`
 * only when this app requires a server behavior an older server does not have.
 * A health body with no `apiVersion` counts as server 0.
 */
export const API_CONTRACT = 1;

export const MIN_SERVER_CONTRACT = 1;

export type MemoryContractNotice = 'server' | 'app';

function contractNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Which side the user has to update, or null when the two can still talk.
 *
 * Server first: a process that does not advertise a contract is 0, and that
 * is "update your Memory server" even if it also asks for a newer app.
 */
export function memoryContractNotice(health: unknown): MemoryContractNotice | null {
  const body =
    health && typeof health === 'object'
      ? (health as { apiVersion?: unknown; minClientVersion?: unknown })
      : {};

  if (contractNumber(body.apiVersion) < MIN_SERVER_CONTRACT) {
    return 'server';
  }

  if (API_CONTRACT < contractNumber(body.minClientVersion)) {
    return 'app';
  }

  return null;
}
