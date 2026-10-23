import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({
  enabled: true,
  status: { synced: 120, bytes: 1_900_000, pending: 30 },
  setEnabled: vi.fn((next: boolean) => {
    h.enabled = next;
  }),
  deleteAll: vi.fn(async (_db: unknown) => undefined),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  isNativePlatform: () => true,
}));
vi.mock('@powersync/react', () => ({ usePowerSync: () => ({}) }));
vi.mock('@/api/powersync/session', () => ({
  clearPowerSyncWorkingSet: async () => undefined,
  measurePowerSyncSizeBytes: async () => 1000,
}));
vi.mock('@/api/powersync/previews', () => ({
  isPreviewSyncEnabled: () => h.enabled,
  setPreviewSyncEnabled: (next: boolean) => h.setEnabled(next),
  subscribePreviewSync: () => () => undefined,
  measurePreviews: async () => h.status,
  deleteAllPreviews: (db: unknown) => h.deleteAll(db),
}));

import { WorkingSetSection } from './WorkingSetSection';

afterEach(() => {
  h.enabled = true;
  h.setEnabled.mockClear();
  h.deleteAll.mockClear();
});

describe('the photo preview store switch', () => {
  it('shows what the phone holds and what is still to fetch', async () => {
    renderWithProviders(<WorkingSetSection />);

    expect(await screen.findByTestId('preview-store-summary')).toHaveTextContent('120 previews');
    expect(screen.getByTestId('preview-store-summary')).toHaveTextContent('30 still to fetch');
    expect(screen.getByRole('switch', { name: /Keep photo previews/ })).toBeChecked();
  });

  it('turning it off asks: cancel changes nothing', async () => {
    renderWithProviders(<WorkingSetSection />);
    fireEvent.click(await screen.findByRole('switch', { name: /Keep photo previews/ }));

    expect(await screen.findByText('Stop keeping photo previews?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('Stop keeping photo previews?')).not.toBeInTheDocument());
    expect(h.setEnabled).not.toHaveBeenCalled();
    expect(h.deleteAll).not.toHaveBeenCalled();
  });

  it('keeping what is here only turns fetching off', async () => {
    renderWithProviders(<WorkingSetSection />);
    fireEvent.click(await screen.findByRole('switch', { name: /Keep photo previews/ }));
    fireEvent.click(await screen.findByRole('button', { name: "Keep what's here, stop fetching" }));

    expect(h.setEnabled).toHaveBeenCalledWith(false);
    expect(h.deleteAll).not.toHaveBeenCalled();
  });

  it('with the switch off, says the remaining previews are not being fetched rather than looking finished', async () => {
    h.enabled = false;
    renderWithProviders(<WorkingSetSection />);

    await screen.findByTestId('preview-store-summary');
    await waitFor(() =>
      expect(screen.getByTestId('preview-store-summary')).toHaveTextContent(
        '30 not fetched while this is off',
      ),
    );
    expect(screen.getByTestId('preview-store-summary')).not.toHaveTextContent('still to fetch');
  });

  it('deleting turns fetching off and removes the previews', async () => {
    renderWithProviders(<WorkingSetSection />);
    fireEvent.click(await screen.findByRole('switch', { name: /Keep photo previews/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete previews and stop' }));

    await waitFor(() => expect(h.deleteAll).toHaveBeenCalled());
    expect(h.setEnabled).toHaveBeenCalledWith(false);
    expect(await screen.findByTestId('preview-store-summary')).toHaveTextContent('0 previews');
  });

  it('turning it on needs no confirmation', async () => {
    h.enabled = false;
    renderWithProviders(<WorkingSetSection />);
    fireEvent.click(await screen.findByRole('switch', { name: /Keep photo previews/ }));

    expect(h.setEnabled).toHaveBeenCalledWith(true);
    expect(screen.queryByText('Stop keeping photo previews?')).not.toBeInTheDocument();
  });
});
