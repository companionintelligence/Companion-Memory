import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

vi.mock('@/api/powersync/deviceFallback', () => ({
  useAnswersFromDevice: () => true,
}));
vi.mock('../LocalListView', () => ({
  LocalListView: ({ sort }: { sort?: string }) => <div data-testid="local-list" data-sort={sort} />,
}));

import { StoryTimelineView } from './StoryTimelineView';

describe('StoryTimelineView while the appliance does not answer', () => {
  it("renders the phone's records as a chronology, in the URL's direction", () => {
    renderWithProviders(<StoryTimelineView />, { route: '/memory?view=timeline' });
    expect(screen.getByTestId('local-list')).toHaveAttribute('data-sort', 'newest');
  });

  it('oldest first when the sort order says so', () => {
    renderWithProviders(<StoryTimelineView />, { route: '/memory?view=timeline&sortOrder=asc' });
    expect(screen.getByTestId('local-list')).toHaveAttribute('data-sort', 'oldest');
  });
});
