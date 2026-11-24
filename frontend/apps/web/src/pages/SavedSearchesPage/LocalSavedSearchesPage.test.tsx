import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  execute: vi.fn(),
}));

vi.mock('@/common/feature', async () => {
  const actual = await vi.importActual<typeof import('@/common/feature')>('@/common/feature');

  return { ...actual, useFeatures: () => ({ isFeatureEnabled: () => true, loading: false }) };
});
vi.mock('@/api/powersync/session', () => ({
  getReplicaDatabase: () => ({ execute: h.execute }),
}));
vi.mock('@/api/powersync/replicaQuery', () => ({
  useReplicaQuery: () => ({ data: h.rows, isLoading: false, error: undefined, refresh: () => {} }),
}));

import { LocalSavedSearchesPage } from './LocalSavedSearchesPage';

function row(overrides: Record<string, unknown>) {
  return {
    id: 'ss-1',
    name: 'Work emails',
    description: 'Inbound mail from work',
    query: 'quarterly',
    entity_types: '["communication"]',
    tags: '["work"]',
    filters: '{"direction":"inbound"}',
    is_public: 0,
    is_seed: 0,
    share_token: null,
    created_at: '2026-10-26T10:00:00Z',
    updated_at: '2026-10-26T11:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  h.rows = [];
  h.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
});

describe('LocalSavedSearchesPage', () => {
  it("lists the phone's own searches with their count, links each to the explorer, and keeps starters apart", async () => {
    h.rows = [row({}), row({ id: 'ss-seed', name: 'Last week', description: null, is_seed: 1 })];
    renderWithProviders(<LocalSavedSearchesPage />, { route: '/saved-searches' });

    expect(await screen.findByText('Work emails')).toBeInTheDocument();
    expect(screen.getByTestId('local-saved-searches-count')).toHaveTextContent('1 saved search');
    expect(screen.queryByText('Last week')).not.toBeInTheDocument();
    expect(screen.getByText('Work emails').closest('a')).toHaveAttribute('href', '/memory?saved_search=ss-1');

    fireEvent.click(screen.getByRole('button', { name: /Starter searches/ }));
    expect(await screen.findByText('Last week')).toBeInTheDocument();
  });

  it("filters by name, description or tag like the appliance's page", async () => {
    h.rows = [row({}), row({ id: 'ss-2', name: 'Trips', description: null, tags: '["travel"]' })];
    renderWithProviders(<LocalSavedSearchesPage />, { route: '/saved-searches?q=travel' });

    expect(await screen.findByText('Trips')).toBeInTheDocument();
    expect(screen.queryByText('Work emails')).not.toBeInTheDocument();
  });

  it("deletes against the phone's table after confirming", async () => {
    h.rows = [row({})];
    renderWithProviders(<LocalSavedSearchesPage />, { route: '/saved-searches' });

    await screen.findByText('Work emails');
    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(h.execute).toHaveBeenCalledWith('DELETE FROM saved_searches WHERE id = ?', ['ss-1']),
    );
  });

  it("renames against the phone's table, leaving the definition alone", async () => {
    h.rows = [row({})];
    renderWithProviders(<LocalSavedSearchesPage />, { route: '/saved-searches' });

    await screen.findByText('Work emails');
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));

    const name = await screen.findByLabelText('Name');

    fireEvent.change(name, { target: { value: 'Work mail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(h.execute).toHaveBeenCalled());
    const [sql, params] = h.execute.mock.calls[0] as [string, unknown[]];

    expect(sql).toContain('UPDATE saved_searches SET name = ?, description = ?, updated_at = ?');
    expect(params[0]).toBe('Work mail');
    expect(params[1]).toBe('Inbound mail from work');
    expect(params[3]).toBe('ss-1');
  });

  it('says what to do when there is nothing saved yet', async () => {
    renderWithProviders(<LocalSavedSearchesPage />, { route: '/saved-searches' });

    expect(await screen.findByText(/You don't have any Saved Searches yet/)).toBeInTheDocument();
    expect(screen.getByText(/kept on this phone and reaches your Memory server/)).toBeInTheDocument();
  });
});
