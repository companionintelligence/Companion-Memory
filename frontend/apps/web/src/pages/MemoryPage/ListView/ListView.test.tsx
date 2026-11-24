import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({ offline: false }));

vi.mock('@/api/powersync/deviceFallback', () => ({
  useAnswersFromDevice: () => h.offline,
}));
vi.mock('../useEntityService', () => ({
  useEntityService: () => [{ error: undefined }, {}],
}));
vi.mock('../LocalListView', () => ({
  LocalListView: () => <div data-testid="local-list" />,
}));
vi.mock('./EntityResultList', () => ({
  EntityResultList: () => <div data-testid="appliance-list" />,
}));

import { ListView } from './ListView';

describe('ListView (the happenings chronology)', () => {
  it("renders the phone's list while the appliance does not answer", () => {
    h.offline = true;
    renderWithProviders(<ListView />, { route: '/memory/events' });

    expect(screen.getByTestId('local-list')).toBeInTheDocument();
    expect(screen.queryByTestId('appliance-list')).not.toBeInTheDocument();
  });

  it("renders the appliance's list otherwise", () => {
    h.offline = false;
    renderWithProviders(<ListView />, { route: '/memory/events' });

    expect(screen.getByTestId('appliance-list')).toBeInTheDocument();
  });
});
