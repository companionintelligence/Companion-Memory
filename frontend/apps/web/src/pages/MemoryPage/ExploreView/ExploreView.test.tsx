import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useEntityService: vi.fn(),
  useAnswersFromDevice: vi.fn(),
}));

vi.mock('../useEntityService', () => ({
  useEntityService: mocks.useEntityService,
}));

vi.mock('@/api/powersync/deviceFallback', () => ({
  useAnswersFromDevice: mocks.useAnswersFromDevice,
}));

vi.mock('../ListView', () => ({
  EntityResultList: ({
    grouped,
    emptyState,
  }: {
    grouped: boolean;
    emptyState: React.ReactNode;
  }) => (
    <div data-testid="entity-result-list" data-grouped={String(grouped)}>
      {emptyState}
    </div>
  ),
}));

vi.mock('../LocalListView', () => ({
  LocalListView: () => <div>Local memory results</div>,
}));

vi.mock('@/pages/MemoryPage/Components', () => ({
  MemoryEmptyState: ({
    filtered,
    whenDroppedTypes,
  }: {
    filtered: boolean;
    whenDroppedTypes: number;
  }) => (
    <div data-testid="memory-empty-state" data-filtered={String(filtered)}>
      dropped:{whenDroppedTypes}
    </div>
  ),
}));

import { ExploreView } from './ExploreView';

function renderExplore(url = '/memory') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ExploreView />
    </MemoryRouter>,
  );
}

describe('ExploreView', () => {
  beforeEach(() => {
    mocks.useEntityService.mockReturnValue([{ error: undefined }, {}]);
    mocks.useAnswersFromDevice.mockReturnValue(false);
  });

  it('shows relevance ordered results by default with an unfiltered empty state', () => {
    renderExplore();

    expect(screen.getByTestId('entity-result-list')).toHaveAttribute('data-grouped', 'false');
    expect(screen.getByTestId('memory-empty-state')).toHaveAttribute('data-filtered', 'false');
  });

  it('groups time-sorted results and marks a search as filtered', () => {
    renderExplore('/memory?sortBy=time&search=coffee');

    expect(screen.getByTestId('entity-result-list')).toHaveAttribute('data-grouped', 'true');
    expect(screen.getByTestId('memory-empty-state')).toHaveAttribute('data-filtered', 'true');
  });

  it('uses the local replica when the service is offline and the device has answers', () => {
    mocks.useEntityService.mockReturnValue([{ error: new Error('offline') }, {}]);
    mocks.useAnswersFromDevice.mockReturnValue(true);

    renderExplore();

    expect(screen.getByText('Local memory results')).toBeInTheDocument();
    expect(screen.queryByTestId('entity-result-list')).not.toBeInTheDocument();
  });
});
