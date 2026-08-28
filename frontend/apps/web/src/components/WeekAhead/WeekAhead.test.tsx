import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DueForecast, WeekForecast } from '@/api/useWeekAheadService';

import { WeekAhead } from './WeekAhead';

const DAY_DATES = [
  '2026-07-10',
  '2026-07-11',
  '2026-07-12',
  '2026-07-13',
  '2026-07-14',
  '2026-07-15',
  '2026-07-16',
];

function makeWeek(
  perDayProbs: Record<string, number[]>,
  scheduledOn: Record<string, number[]> = {},
): WeekForecast {
  return {
    horizon: '7d',
    generatedAt: '2026-07-09T09:41:00Z',
    days: DAY_DATES.map((date, i) => ({
      date,
      dow: 'Friday',
      clusters: Object.entries(perDayProbs)
        .filter(([, probs]) => probs[i] > 0)
        .map(([name, probs]) => ({
          clusterId: `id-${name}`,
          name,
          l0Class: name === 'Gym Session' ? 'EXERCISE' : 'WORK',
          pOccur: probs[i],
          scheduled: (scheduledOn[name] ?? []).includes(i),
          daypartProbs: [{ label: 'morning', probability: 0.7 }],
        })),
    })),
  };
}

const DUE: DueForecast = {
  generatedAt: '2026-07-09T09:41:00Z',
  due: [
    {
      clusterId: 'id-friends',
      name: 'See Friends',
      l0Class: 'SOCIAL',
      lastSeen: '2026-06-23',
      daysSinceLast: 16,
      medianIntervalDays: 7,
      dueInDays: -9,
      window: [-9, -7],
      overdue: true,
      scheduledDate: null,
      confidence: 0.72,
    },
    {
      clusterId: 'id-haircut',
      name: 'Haircut',
      l0Class: 'ERRAND',
      lastSeen: '2026-06-10',
      daysSinceLast: 29,
      medianIntervalDays: 35,
      dueInDays: 6,
      window: [3, 9],
      overdue: false,
      scheduledDate: null,
      confidence: 0.66,
    },
  ],
};

describe('WeekAhead', () => {
  it('renders one organic row per discovered cluster with opacity ∝ probability', () => {
    const week = makeWeek({
      'Deep Focus': [0.9, 0.1, 0.1, 0.9, 0.9, 0.9, 0.8],
      'Gym Session': [0.2, 0.5, 0.1, 0.1, 0.8, 0.1, 0.7],
    });
    const { container } = render(<WeekAhead week={week} due={null} />);

    expect(screen.getByText('Deep Focus')).toBeInTheDocument();
    expect(screen.getByText('Gym Session')).toBeInTheDocument();

    // Cells carry the L0 class and probability as opacity. Selected by the class
    // itself rather than by the colour it happens to render as — the palette is
    // shared with the schedule surface and free to be re-stepped.
    const workCells = container.querySelectorAll('[data-l0="WORK"]');
    expect(workCells).toHaveLength(7);
    expect((workCells[0] as HTMLElement).style.opacity).toBe('0.9');
    expect((workCells[1] as HTMLElement).style.opacity).toBe('0.1');
  });

  it('caps the grid at 8 rows ranked by peak probability', () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`Cluster ${i}`, DAY_DATES.map(() => 0.1 + i * 0.05)]),
    );
    const { container } = render(<WeekAhead week={makeWeek(many)} due={null} />);

    // 8 label cells + 8×7 grid cells; the lowest-probability clusters are dropped
    expect(screen.queryByText('Cluster 11')).toBeInTheDocument();
    expect(screen.queryByText('Cluster 0')).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-l0]')).toHaveLength(56);
  });

  it('shows overdue items with the deviation message and upcoming items with a due window', () => {
    const week = makeWeek({ 'Deep Focus': [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9] });
    render(<WeekAhead week={week} due={DUE} />);

    expect(screen.getByText('Coming due')).toBeInTheDocument();
    expect(screen.getByText('See Friends')).toBeInTheDocument();
    expect(screen.getByText('16 days since last · usually every ~7 days')).toBeInTheDocument();
    expect(screen.getByText('due in ~6 days (3–9 days)')).toBeInTheDocument();
  });

  it('shows only the all-caught-up empty state when nothing is due', () => {
    const week = makeWeek({ 'Deep Focus': [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9] });
    const { container } = render(
      <WeekAhead week={week} due={{ generatedAt: '2026-07-09T09:41:00Z', due: [] }} />,
    );

    expect(screen.getByText('Coming due')).toBeInTheDocument();
    expect(screen.getByText('All caught up — take a break!')).toBeInTheDocument();
    // No due rows render alongside the empty-state message
    expect(container.querySelectorAll('.grid.grid-cols-\\[auto_minmax\\(0\\,1fr\\)\\]')).toHaveLength(0);
  });

  it('rings scheduled grid cells and reframes booked due items as scheduled', () => {
    const week = makeWeek(
      { 'Gym Session': [0.2, 0.5, 0.1, 0.1, 1.0, 0.1, 0.7] },
      { 'Gym Session': [4] }, // day index 4 is on the calendar
    );
    const due: DueForecast = {
      generatedAt: '2026-07-09T09:41:00Z',
      due: [
        {
          clusterId: 'id-family',
          name: 'Family Call',
          l0Class: 'SOCIAL',
          lastSeen: '2026-06-27',
          daysSinceLast: 12,
          medianIntervalDays: 14,
          dueInDays: 2,
          window: [1, 4],
          overdue: false,
          scheduledDate: '2026-07-12',
          confidence: 0.8,
        },
      ],
    };
    const { container } = render(<WeekAhead week={week} due={due} />);

    // Exactly one grid cell carries the scheduled ring
    expect(container.querySelectorAll('.ring-2')).toHaveLength(1);
    // The booked due item is reframed, not shown as a countdown
    expect(screen.getByText(/scheduled \w+/)).toBeInTheDocument();
    expect(screen.getByLabelText('on your calendar')).toBeInTheDocument();
  });

  it('hides junk cluster names even when probability is high', () => {
    const week = makeWeek({
      Drs: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
      'No Think': [0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8],
      'Deep Focus': [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
    });
    render(<WeekAhead week={week} due={null} />);

    expect(screen.getByText('Deep Focus')).toBeInTheDocument();
    expect(screen.queryByText('Drs')).not.toBeInTheDocument();
    expect(screen.queryByText('No Think')).not.toBeInTheDocument();
  });

  it('renders nothing when no cluster clears the floor', () => {
    const empty: WeekForecast = {
      horizon: '7d',
      generatedAt: '2026-07-09T09:41:00Z',
      days: DAY_DATES.map((date) => ({ date, dow: 'Friday', clusters: [] })),
    };
    const { container } = render(<WeekAhead week={empty} due={DUE} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when week data is null', () => {
    const { container } = render(<WeekAhead week={null} due={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
