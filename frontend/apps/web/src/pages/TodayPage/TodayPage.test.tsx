import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TodayPage } from './TodayPage';

const features = vi.hoisted(() => ({ scheduleEnabled: true }));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  usePageTitle: () => undefined,
}));
vi.mock('@/common/feature', () => ({
  useFeatures: () => ({
    isFeatureEnabled: (flag: string) => (flag === 'schedule.page' ? features.scheduleEnabled : true),
  }),
}));
vi.mock('@/components/layout', () => ({
  PageContent: ({
    children,
    className,
    scroll = true,
  }: {
    children: React.ReactNode;
    className?: string;
    scroll?: boolean;
  }) => (
    <main data-testid="page-content" data-scroll={String(scroll)} className={className}>
      {children}
    </main>
  ),
}));

vi.mock('@/pages/SchedulePage', () => ({
  SchedulePage: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="schedule">schedule embedded={String(embedded)}</div>
  ),
}));

/**
 * Today is the calendar, full page, and nothing else. The schedule is embedded
 * so it draws no chrome of its own, and this page does not scroll — the day
 * grid is the only scroller. `schedule.page` still hides it.
 */
describe('TodayPage', () => {
  beforeEach(() => {
    features.scheduleEnabled = true;
  });

  it('shows the schedule, embedded so it draws no chrome of its own', () => {
    render(<TodayPage />);

    expect(screen.getByTestId('schedule')).toHaveTextContent('embedded=true');
  });

  it('drops the schedule when schedule.page is off', () => {
    features.scheduleEnabled = false;

    render(<TodayPage />);

    expect(screen.queryByTestId('schedule')).not.toBeInTheDocument();
  });

  it('keeps the phone flush and adds a small desktop top inset for the week range', () => {
    render(<TodayPage />);

    const frame = screen.getByTestId('page-content');

    expect(frame.className).toContain('p-0');
    expect(frame.className).toContain('device:pt-3');
    expect(frame.className).not.toContain('device:p-6');
  });

  it('lets the day grid be the only scroller', () => {
    render(<TodayPage />);

    expect(screen.getByTestId('page-content')).toHaveAttribute('data-scroll', 'false');
  });
});
