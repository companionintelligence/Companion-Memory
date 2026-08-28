import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { StatsPage } from './StatsPage';
import type { MemoryStats } from './useStatsService';

const refresh = vi.fn();

const emptyStats: MemoryStats = {
  totals: { events: 12, entities: 8, relationships: 3 },
  dateRange: { earliest: '2026-01-01T00:00:00.000Z', latest: '2026-08-01T00:00:00.000Z' },
  bySource: [],
  byTag: [],
  byEntityType: [{ type: 'Person', count: 4 }],
  byRelationshipType: [],
  spend: { rows: [] },
  time: { mode: 'counts', coverage: { timedEvents: 0, consideredEvents: 0 }, rows: [] },
  conversations: { rows: [] },
  social: { granularity: 'week', rows: [] },
  channels: { rows: [] },
  insights: [],
};

const fullStats: MemoryStats = {
  ...emptyStats,
  spend: {
    rows: [
      {
        merchant: 'Cafe Nero',
        count: 4,
        totalMinor: 2800,
        avgMinor: 700,
        currency: 'USD',
        sources: ['venmo'],
      },
    ],
  },
  time: {
    mode: 'hours',
    coverage: { timedEvents: 3, consideredEvents: 3 },
    rows: [{ bucket: 'calendar', label: 'Calendar', minutes: 120, count: 3 }],
  },
  conversations: {
    rows: [
      {
        personId: '019fd7c0-641c-76dd-8ed7-a5053faff6fb',
        name: 'Alex',
        count: 47,
        inbound: 20,
        outbound: 27,
        lastAt: null,
      },
    ],
  },
  social: {
    granularity: 'week',
    rows: [{ bucket: '2026-08-03T00:00:00.000Z', sourceSystem: 'instagram', kind: 'like', count: 6 }],
  },
  insights: [
    {
      id: 'top-person',
      title: 'Most messaged',
      body: 'Alex (47 messages)',
      href: '/people/019fd7c0-641c-76dd-8ed7-a5053faff6fb',
    },
  ],
};

const h = vi.hoisted(() => ({
  data: null as MemoryStats | null,
  loading: false,
  error: null as string | null,
}));

vi.mock('./useStatsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useStatsService')>();

  return {
    ...actual,
    useStatsService: () => ({
      data: h.data,
      loading: h.loading,
      error: h.error,
      refresh,
    }),
  };
});

vi.mock('@/common/feature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common/feature')>();

  return { ...actual, useFeatures: () => ({ isFeatureEnabled: () => true }) };
});

describe('StatsPage', () => {
  it('renders spend, time, and conversation charts when those series have data', () => {
    h.data = fullStats;
    h.loading = false;
    h.error = null;

    renderWithProviders(<StatsPage />);

    expect(screen.getByText('Spending')).toBeInTheDocument();
    expect(screen.getByText('Cafe Nero')).toBeInTheDocument();
    expect(screen.getByText('How time is spent')).toBeInTheDocument();
    expect(screen.getByText('Conversations')).toBeInTheDocument();
    expect(
      screen
        .getAllByRole('link')
        .some((link) => link.getAttribute('href') === '/people/019fd7c0-641c-76dd-8ed7-a5053faff6fb'),
    ).toBe(true);
    expect(screen.getByText('Most messaged')).toBeInTheDocument();
    expect(screen.getByText('Entities by type')).toBeInTheDocument();
  });

  it('shows honest empty copy when a series has no data', () => {
    h.data = emptyStats;
    h.loading = false;
    h.error = null;

    renderWithProviders(<StatsPage />);

    expect(screen.getByText(/No parseable payment amounts/)).toBeInTheDocument();
    expect(screen.getByText(/No calendar, media, place, or travel events/)).toBeInTheDocument();
    expect(screen.getByText('No messages in this range.')).toBeInTheDocument();
    expect(screen.getByText(/No likes imported yet/)).toBeInTheDocument();
  });

  it('exposes the range control', () => {
    h.data = emptyStats;
    h.loading = false;
    h.error = null;

    renderWithProviders(<StatsPage />);

    fireEvent.click(screen.getByRole('radio', { name: '30 days' }));
    expect(screen.getByRole('radio', { name: '30 days' })).toBeChecked();
  });

  it('opens on all time, so the charts and the all-time tiles share one clock', () => {
    h.data = fullStats;
    h.loading = false;
    h.error = null;

    renderWithProviders(<StatsPage />);

    expect(screen.getByRole('radio', { name: 'All time' })).toBeChecked();
    // Nothing is filtered out on the default view, so nothing is explained away.
    expect(screen.queryByText(/No messages, payments, or posts/)).not.toBeInTheDocument();
  });

  it('says the window is empty rather than rendering three blank charts', () => {
    h.data = emptyStats;
    h.loading = false;
    h.error = null;

    renderWithProviders(<StatsPage />);

    fireEvent.click(screen.getByRole('radio', { name: '30 days' }));

    expect(screen.getByText(/No messages, payments, or posts in the last 30 days/)).toBeInTheDocument();
    // …and names where the data actually is, so an empty window is legible as
    // "wrong window", not "no data". Matched on the assembled sentence because
    // the dates are wrapped in their own tabular-nums spans.
    expect(
      screen.getByText(
        (_content, element) =>
          element?.textContent ===
          'Your memory runs 2026-01-01 → 2026-08-01. The tiles below stay all-time either way.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all time' }));
    expect(screen.getByRole('radio', { name: 'All time' })).toBeChecked();
    expect(screen.queryByText(/No messages, payments, or posts/)).not.toBeInTheDocument();
  });

  it('keeps quiet when the window holds only future calendar entries', () => {
    // `time` alone is not evidence the window has activity in it — a scheduled
    // meeting is not something that happened — but a channel row is.
    h.data = {
      ...emptyStats,
      time: {
        mode: 'counts',
        coverage: { timedEvents: 0, consideredEvents: 2 },
        rows: [{ bucket: 'calendar', label: 'Calendar', minutes: 0, count: 2 }],
      },
      channels: { rows: [{ source: 'whatsapp', count: 16 }] },
    };
    h.loading = false;
    h.error = null;

    renderWithProviders(<StatsPage />);

    fireEvent.click(screen.getByRole('radio', { name: '30 days' }));
    expect(screen.queryByText(/No messages, payments, or posts/)).not.toBeInTheDocument();
  });
});
