import {
  amountToMinorSql,
  buildLifeInsights,
  isOutgoingSpend,
  labelChannel,
  parseAmountToMinor,
  parseStatsBound,
  resolveTimeMode,
  timeBucketForEventType,
  type TimeSeries,
} from '../lifeStats';

describe('parseAmountToMinor', () => {
  it('parses signed Venmo-style amounts into cents', () => {
    expect(parseAmountToMinor('-$12.00')).toBe(-1200);
    expect(parseAmountToMinor('+$74.00')).toBe(7400);
  });

  it('strips currency and grouping', () => {
    expect(parseAmountToMinor('$1,299.00')).toBe(129900);
    expect(parseAmountToMinor('USD 19.99')).toBe(1999);
  });

  it('returns null when there is no number', () => {
    expect(parseAmountToMinor(null)).toBeNull();
    expect(parseAmountToMinor('')).toBeNull();
    expect(parseAmountToMinor('n/a')).toBeNull();
    expect(parseAmountToMinor('-')).toBeNull();
  });
});

describe('isOutgoingSpend', () => {
  it('treats classified outgoing types as spend regardless of sign', () => {
    expect(isOutgoingSpend('payment', -1200)).toBe(true);
    expect(isOutgoingSpend('purchase', 1999)).toBe(true);
    expect(isOutgoingSpend('order', 5000)).toBe(true);
  });

  it('keeps unsigned transactions only when the amount is negative', () => {
    expect(isOutgoingSpend('transaction', -500)).toBe(true);
    expect(isOutgoingSpend('transaction', 500)).toBe(false);
  });

  it('drops credits and zero amounts', () => {
    expect(isOutgoingSpend('credit', 7400)).toBe(false);
    expect(isOutgoingSpend('payment', 0)).toBe(false);
    expect(isOutgoingSpend('payment', null)).toBe(false);
  });
});

describe('timeBucketForEventType', () => {
  it('maps known types and leaves the rest unbucketed', () => {
    expect(timeBucketForEventType('meeting')).toBe('calendar');
    expect(timeBucketForEventType('watch')).toBe('media');
    expect(timeBucketForEventType('place')).toBe('places');
    expect(timeBucketForEventType('trip')).toBe('travel');
    expect(timeBucketForEventType('like')).toBeNull();
    expect(timeBucketForEventType(null)).toBeNull();
  });
});

describe('parseStatsBound', () => {
  it('accepts ISO timestamps and rejects junk', () => {
    expect(parseStatsBound('2026-05-01T00:00:00.000Z')?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(parseStatsBound('')).toBeNull();
    expect(parseStatsBound('not-a-date')).toBeNull();
  });
});

describe('amountToMinorSql', () => {
  it('uses the same cleanup class as parseAmountToMinor', () => {
    expect(amountToMinorSql('e.metadata')).toContain("e.metadata->>'Amount'");
    expect(amountToMinorSql('e.metadata')).toContain('[^0-9.+-]');
  });
});

describe('buildLifeInsights', () => {
  const emptyTime: TimeSeries = {
    mode: 'hours',
    coverage: { timedEvents: 0, consideredEvents: 0 },
    rows: [],
  };

  it('omits cards when a series is empty', () => {
    expect(buildLifeInsights({ spend: [], time: emptyTime, conversations: [], channels: [] })).toEqual([]);
  });

  it('builds cards from the top row of each series', () => {
    const insights = buildLifeInsights({
      spend: [
        {
          merchant: 'Cafe Nero',
          count: 4,
          totalMinor: 2800,
          avgMinor: 700,
          currency: 'USD',
          sources: ['venmo'],
        },
      ],
      time: {
        mode: 'hours',
        coverage: { timedEvents: 3, consideredEvents: 3 },
        rows: [{ bucket: 'calendar', label: 'Calendar', minutes: 120, count: 3, spanCount: 0, spanDays: 0 }],
      },
      conversations: [
        {
          personId: 'person-1',
          name: 'Alex',
          count: 47,
          inbound: 20,
          outbound: 27,
          lastAt: null,
        },
      ],
      channels: [{ source: 'imessage', count: 90 }],
    });

    expect(insights.map((card) => card.id)).toEqual(['top-person', 'top-spend', 'top-time', 'top-channel']);
    expect(insights[0]).toMatchObject({
      body: 'Alex (47 messages)',
      href: '/people/person-1',
    });
    expect(insights[1].body).toContain('Cafe Nero');
    expect(insights[1].body).toContain('$28.00');
    expect(insights[2].body).toBe('Calendar (2h)');
    expect(insights[3].body).toContain('iMessage');
  });

  it('labels known channels', () => {
    expect(labelChannel('imessage')).toBe('iMessage');
    expect(labelChannel('unknown-app')).toBe('unknown-app');
  });

  it('uses event counts when duration coverage is empty', () => {
    const insights = buildLifeInsights({
      spend: [],
      time: {
        mode: 'counts',
        coverage: { timedEvents: 0, consideredEvents: 10 },
        rows: [{ bucket: 'media', label: 'Media', minutes: 0, count: 10, spanCount: 0, spanDays: 0 }],
      },
      conversations: [],
      channels: [],
    });

    expect(insights[0]).toMatchObject({ title: 'Most events', body: 'Media (10 events)' });
  });
});

describe('resolveTimeMode', () => {
  it('uses counts when duration coverage is thin', () => {
    expect(resolveTimeMode(1, 20, 60)).toBe('counts');
  });

  it('uses hours when enough events have a duration', () => {
    expect(resolveTimeMode(8, 20, 120)).toBe('hours');
  });

  it('uses counts when no minutes exist', () => {
    expect(resolveTimeMode(20, 20, 0)).toBe('counts');
  });
});
