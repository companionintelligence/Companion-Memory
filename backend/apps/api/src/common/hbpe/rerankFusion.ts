/**
 * How a re-scored head of a fused search list is combined with its existing
 * order. Used only when `SEARCH_TRAINED_RERANK` is on.
 *
 * For the head of N candidates (N is at most {@link RERANK_TOP_N}), with `i` the
 * zero-based position in the Reciprocal Rank Fusion order:
 *
 *   orderScore(i) = (N - 1 - i) / (N - 1)     first = 1, last = 0; 1 when N = 1
 *   relevance(i)  = the sidecar's `score` for the passage, clamped to [0, 1]
 *                   (0.85 · P(is_relevant) + 0.15 · temporal_freshness / 2)
 *   final(i)      = w · relevance(i) + (1 - w) · orderScore(i)
 *
 * with `w` = {@link RERANK_RELEVANCE_WEIGHT} = 0.5. Candidates are then ordered
 * by `final`, ties going to the earlier RRF position.
 *
 * Only candidates the sidecar scored move, and they move among the slots they
 * already occupy. A candidate with no score (no passage text, or missing from the
 * reply) keeps its position, so the rest of the head stays where RRF put it.
 */
/**
 * Candidates re-scored per query. The sidecar scores passages one at a time, and
 * 50 was never shown to fit the 800 ms decision budget, so the head stays at 20.
 */
export const RERANK_TOP_N = 20;

/** Share of the final order that comes from the sidecar's relevance score. */
export const RERANK_RELEVANCE_WEIGHT = 0.5;

export function fuseRerankOrder<T>(
  head: readonly T[],
  keyOf: (item: T) => string,
  scores: ReadonlyMap<string, number>,
  weight: number = RERANK_RELEVANCE_WEIGHT,
): T[] {
  const n = head.length;
  const scored: Array<{ item: T; index: number; final: number }> = [];

  head.forEach((item, index) => {
    const relevance = scores.get(keyOf(item));

    if (relevance === undefined || !Number.isFinite(relevance)) {
      return;
    }

    const order = n > 1 ? (n - 1 - index) / (n - 1) : 1;
    const clamped = Math.min(1, Math.max(0, relevance));

    scored.push({ item, index, final: weight * clamped + (1 - weight) * order });
  });

  if (scored.length < 2) {
    return [...head];
  }

  const best = [...scored].sort((a, b) => b.final - a.final || a.index - b.index);
  const slots = scored.map((entry) => entry.index).sort((a, b) => a - b);
  const out = [...head];

  best.forEach((entry, rank) => {
    out[slots[rank] as number] = entry.item;
  });

  return out;
}
