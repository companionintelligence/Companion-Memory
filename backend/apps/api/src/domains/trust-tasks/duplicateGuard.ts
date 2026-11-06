/**
 * Duplicate-execution protection — SPEC §7.2 item 11, as the HTTPS binding's §5.1 spells it out.
 *
 * The transport supplies no freshness, so the only thing between a captured request and a repeated
 * effect is the consumer's record of what it has already accepted. Three outcomes, and the difference
 * between the last two is the whole point of the rule:
 *
 *   first      never seen under this `id`: record it and execute
 *   duplicate  this exact document (same `id`, same RFC 8785 serialization, `proof` included) again:
 *              absorb it — do NOT execute a second time
 *   conflict   a DIFFERENT document under an `id` already accepted: `idConflict`, and not a retry
 *
 * ═══ WHY TWO CLAIMS AND NOT ONE ═══
 *
 * The store this sits on can only say "first caller wins" for a key (`ConsumptionStore.claimOnce`); it
 * cannot hand back what was stored. So the document's identity is encoded in a key: the exact
 * (id, digest) pair is claimed first, then the `id` alone.
 *
 *   exact pair already claimed          → duplicate. Two concurrent arrivals of the SAME bytes cannot
 *                                         both get past this, so neither is ever mis-reported as a
 *                                         conflict.
 *   pair new, `id` already claimed      → conflict. Another document owns this `id`.
 *   pair new, `id` new                  → first.
 *
 * Claiming the `id` first would misreport the concurrent same-bytes case as a conflict; claiming the
 * pair first cannot.
 *
 * The record is kept as long as the consumer is willing to execute the document (§7.2, "Bounding the
 * record"), so `expiresAtMs` is the end of the acceptance window plus its skew. A store that cannot
 * reach its backing state returns false from `claimOnce` (fail closed), which reads here as `duplicate`:
 * nothing executes. It also means an outage is indistinguishable from a replay — a limitation of the
 * store's boolean contract, not of this rule.
 */

export type ClaimOutcome = 'first' | 'duplicate' | 'conflict';

export interface DuplicateGuard {
  claim(params: { id: string; digest: string; now: number; expiresAtMs: number }): Promise<ClaimOutcome>;
}

/** The slice of `ConsumptionStore` this needs; the real one satisfies it structurally. */
export interface ClaimStore {
  claimOnce(params: { key: string; now: number; expiresAtMs: number }): Promise<boolean>;
}

export class StoreDuplicateGuard implements DuplicateGuard {
  constructor(private readonly store: ClaimStore) {}

  async claim(params: {
    id: string;
    digest: string;
    now: number;
    expiresAtMs: number;
  }): Promise<ClaimOutcome> {
    const { id, digest, now, expiresAtMs } = params;

    const exact = await this.store.claimOnce({ key: `trust-task:doc:${id}\n${digest}`, now, expiresAtMs });
    if (!exact) {
      return 'duplicate';
    }

    const owner = await this.store.claimOnce({ key: `trust-task:id:${id}`, now, expiresAtMs });

    return owner ? 'first' : 'conflict';
  }
}
