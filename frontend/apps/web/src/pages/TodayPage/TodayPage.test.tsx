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
  PageContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <main data-testid="page-content" className={className}>
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
 * Today is the calendar, full page, and nothing else. Two things have to
 * hold: it is asked for in its embedded variant — PageContent is the page's
 * scroll container, so a child rendering its own would put two scrollbars and
 * two sets of padding on one screen — and that `schedule.page` still hides
 * it, which it used to do by removing a route that no longer exists.
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
});
