import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import { TimelineGrid } from './TimelineGrid';
import type { TimelineGridDatum } from './TimelineGrid';
import { TimelineGridSelectionProvider, useTimelineGridSelection } from './useTimelineGridSelection';
import type { TimelineGridRange } from './useTimelineGridSelection';

// Fixed window + seeded PRNG so the stories render identically every run.
const WINDOW_START = '2025-07-10';
const WINDOW_END = '2026-07-09';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateData(startKey: string, endKey: string, seed = 42): TimelineGridDatum[] {
  const rand = mulberry32(seed);
  const out: TimelineGridDatum[] = [];
  const [y, m, d] = startKey.split('-').map(Number);
  let cursor = new Date(y, m - 1, d);

  const toKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  while (toKey(cursor) <= endKey) {
    const isWeekend = cursor.getDay() === 0 || cursor.getDay() === 6;
    const quiet = rand() < (isWeekend ? 0.55 : 0.2);
    if (!quiet) {
      out.push({
        date: toKey(cursor),
        count: Math.ceil(rand() * (isWeekend ? 8 : 24)),
      });
    }

    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
  }

  return out;
}

const YEAR_DATA = generateData(WINDOW_START, WINDOW_END);

const meta: Meta<typeof TimelineGrid> = {
  component: TimelineGrid,
  parameters: {
    layout: 'centered',
  },
  args: {
    data: YEAR_DATA,
    start: WINDOW_START,
    end: WINDOW_END,
  },
  decorators: [
    (Story) => (
      <TimelineGridSelectionProvider args={[]}>
        <Story />
      </TimelineGridSelectionProvider>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof TimelineGrid>;

export const Default: Story = {
  decorators: [
    (Story) => (
      <div className="h-[640px]">
        <Story />
      </div>
    ),
  ],
};

export const FillsViewport: Story = {
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="h-screen w-full p-6">
        <Story />
      </div>
    ),
  ],
};

/**
 * Reads and mutates the selection from outside the grid via the provider hook —
 * the same way an app-side filter bar would.
 */
function SelectionControls(args: ComponentProps<typeof TimelineGrid>) {
  const [{ selection }, { setSelection, clearSelection }] = useTimelineGridSelection();

  useEffect(() => {
    setSelection({ start: '2026-01-05', end: '2026-02-14' });
  }, [setSelection]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="tabular-nums text-muted-foreground">
          {selection ? `${selection.start} → ${selection.end}` : 'No selection'}
        </span>
        <button type="button" className="rounded border px-2 py-0.5" onClick={clearSelection}>
          Clear
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <TimelineGrid {...args} />
      </div>
    </div>
  );
}

export const WithSelection: Story = {
  decorators: [
    (Story) => (
      <div className="h-[640px]">
        <Story />
      </div>
    ),
  ],
  render: (args) => <SelectionControls {...args} />,
};

/**
 * Mirrors `onTimeRangeChange` emissions above the grid — scroll the grid to
 * move the visible window through the three years of history.
 */
function TimeRangeReadout(args: ComponentProps<typeof TimelineGrid>) {
  const [range, setRange] = useState<TimelineGridRange | null>(null);

  return (
    <div className="flex h-full flex-col gap-3">
      <span className="tabular-nums text-xs text-muted-foreground">
        {range ? `${range.start} → ${range.end}` : 'No range emitted yet'}
      </span>
      <div className="min-h-0 flex-1">
        <TimelineGrid {...args} onTimeRangeChange={setRange} />
      </div>
    </div>
  );
}

export const ScrollThroughTime: Story = {
  args: {
    start: '2023-07-10',
    data: generateData('2023-07-10', WINDOW_END, 11),
  },
  decorators: [
    (Story) => (
      <div className="h-[640px]">
        <Story />
      </div>
    ),
  ],
  render: (args) => <TimeRangeReadout {...args} />,
};

export const SixMonths: Story = {
  args: {
    start: '2026-01-10',
    data: generateData('2026-01-10', WINDOW_END, 7),
  },
  decorators: [
    (Story) => (
      <div className="h-[640px]">
        <Story />
      </div>
    ),
  ],
};

export const Empty: Story = {
  args: {
    data: [],
  },
  decorators: [
    (Story) => (
      <div className="h-[640px]">
        <Story />
      </div>
    ),
  ],
};
