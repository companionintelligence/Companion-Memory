import { assembleDailyMetrics } from './assembleDailyMetrics';
import type { RawDailyAggregates } from './dailyAggregateSql';

const EMPTY: RawDailyAggregates = {
  comms_rows: 0,
  comms_outbound: 0,
  comms_threads: 0,
  comms_nullthread_rows: 0,
  comms_unique_contacts: 0,
  comms_sentiment_sum: null,
  comms_sentiment_count: 0,
  pos_rows: 0,
  pos_rows_with_location: 0,
  pos_place_cells: 0,
  pos_km: null,
  br_rows: 0,
  br_rows_with_duration: 0,
  br_duration_seconds_sum: null,
  br_distinct_domains: 0,
  inv_rows: 0,
  inv_rows_with_price: 0,
  inv_price_sum: null,
};

function raw(overrides: Partial<RawDailyAggregates>): RawDailyAggregates {
  return { ...EMPTY, ...overrides };
}

describe('assembleDailyMetrics — communications', () => {
  it('derives message/conversation/contact/ratio/sentiment metrics', () => {
    const { metrics, coverage } = assembleDailyMetrics(
      raw({
        comms_rows: 10,
        comms_outbound: 4,
        comms_threads: 3,
        comms_nullthread_rows: 2,
        comms_unique_contacts: 5,
        comms_sentiment_sum: 2.5,
        comms_sentiment_count: 5,
      }),
    );

    expect(metrics.n_messages).toBe(10);
    expect(metrics.n_conversations).toBe(5); // 3 threads + 2 un-threaded
    expect(metrics.n_unique_contacts).toBe(5);
    expect(metrics.outbound_ratio).toBeCloseTo(0.4, 5);
    expect(metrics.avg_sentiment).toBeCloseTo(0.5, 5); // 2.5 / 5

    expect(coverage.n_messages).toBe(1);
    expect(coverage.outbound_ratio).toBe(1);
    // only 5 of 10 messages were scored
    expect(coverage.avg_sentiment).toBeCloseTo(0.5, 5);
  });

  it('returns NULL (not 0) for every comms metric when there are no messages', () => {
    const { metrics, coverage } = assembleDailyMetrics(EMPTY);

    expect(metrics.n_messages).toBeNull();
    expect(metrics.n_conversations).toBeNull();
    expect(metrics.outbound_ratio).toBeNull();
    expect(metrics.avg_sentiment).toBeNull();

    // absence is coverage 0 — never a real zero value
    expect(coverage.n_messages).toBe(0);
    expect(coverage.avg_sentiment).toBe(0);
  });

  it('averages sentiment over only the scored messages', () => {
    const { metrics, coverage } = assembleDailyMetrics(
      raw({ comms_rows: 4, comms_sentiment_sum: -0.6, comms_sentiment_count: 2 }),
    );

    expect(metrics.avg_sentiment).toBeCloseTo(-0.3, 5); // -0.6 / 2
    expect(coverage.avg_sentiment).toBeCloseTo(0.5, 5); // 2 of 4 scored
  });
});

describe('assembleDailyMetrics — position', () => {
  it('counts places and sums distance when at least two pings are located', () => {
    const { metrics, coverage } = assembleDailyMetrics(
      raw({ pos_rows: 4, pos_rows_with_location: 3, pos_place_cells: 2, pos_km: 1.2 }),
    );

    expect(metrics.n_places).toBe(2);
    expect(metrics.km_traveled).toBeCloseTo(1.2, 5);
    expect(coverage.n_places).toBeCloseTo(0.75, 5); // 3 of 4 located
    expect(coverage.km_traveled).toBeCloseTo(0.75, 5);
  });

  it('leaves km_traveled NULL with a single located ping (no distance possible)', () => {
    const { metrics } = assembleDailyMetrics(
      raw({ pos_rows: 1, pos_rows_with_location: 1, pos_place_cells: 1, pos_km: null }),
    );

    expect(metrics.n_places).toBe(1);
    expect(metrics.km_traveled).toBeNull();
  });
});

describe('assembleDailyMetrics — browser & money', () => {
  it('converts screen seconds to minutes and counts domains', () => {
    const { metrics, coverage } = assembleDailyMetrics(
      raw({
        br_rows: 5,
        br_rows_with_duration: 4,
        br_duration_seconds_sum: 600,
        br_distinct_domains: 3,
      }),
    );

    expect(metrics.screen_minutes).toBeCloseTo(10, 5); // 600s / 60
    expect(metrics.n_domains).toBe(3);
    expect(coverage.screen_minutes).toBeCloseTo(0.8, 5); // 4 of 5 timed
  });

  it('sums spend only over priced items, and NULLs it when none are priced', () => {
    const priced = assembleDailyMetrics(raw({ inv_rows: 3, inv_rows_with_price: 2, inv_price_sum: 59.98 }));
    expect(priced.metrics.spend_total).toBeCloseTo(59.98, 2);
    expect(priced.coverage.spend_total).toBeCloseTo(2 / 3, 5);

    const unpriced = assembleDailyMetrics(raw({ inv_rows: 2, inv_rows_with_price: 0 }));
    expect(unpriced.metrics.spend_total).toBeNull();
    expect(unpriced.coverage.spend_total).toBe(0);
  });
});
