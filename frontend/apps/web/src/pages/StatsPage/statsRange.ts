export const STATS_RANGES = ['30d', '90d', '1y', 'all'] as const;

export type StatsRange = (typeof STATS_RANGES)[number];

/**
 * All time, because everything else on this page already is.
 *
 * The four tiles (Events / Entities / Relationships / Date range) and the three
 * breakdown cards are all-time and the range toggle does not touch them, so any
 * bounded default puts the charts and the tiles on different clocks. It showed:
 * on a corpus whose last import ended months ago, the `90d` default opened with
 * `spend.rows = 0` and `social.rows = 0` sitting beside tiles reading
 * "Events 127,703 / Entities 507,481" — a page that looks broken while holding
 * twenty years of data.
 *
 * A personal archive is mostly imported history, so "the last 90 days" is the
 * one window that is reliably empty right after an import — the worst possible
 * first impression and the least likely thing the owner wanted. The narrower
 * windows stay one click away, and picking one that holds nothing now says so
 * (see StatsPage's empty-window notice) instead of rendering blank charts.
 */
export const DEFAULT_STATS_RANGE: StatsRange = 'all';

export const STATS_RANGE_LABELS: Readonly<Record<StatsRange, string>> = {
  '30d': '30 days',
  '90d': '90 days',
  '1y': '1 year',
  all: 'All time',
};

/** ISO bounds for the life-series query. `all` omits both so the API is unbounded. */
export function rangeToBounds(range: StatsRange, now = new Date()): { from?: string; to?: string } {
  if (range === 'all') {
    return {};
  }

  const to = now.toISOString();
  const from = new Date(now.getTime());

  if (range === '30d') {
    from.setUTCDate(from.getUTCDate() - 30);
  } else if (range === '90d') {
    from.setUTCDate(from.getUTCDate() - 90);
  } else {
    from.setUTCFullYear(from.getUTCFullYear() - 1);
  }

  return { from: from.toISOString(), to };
}
