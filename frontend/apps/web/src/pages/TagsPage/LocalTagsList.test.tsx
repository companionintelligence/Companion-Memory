import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({
  tags: [] as Array<{ id: string; label: string; description: string | null; entityCount: number }>,
}));

vi.mock('@/api/powersync/session', () => ({
  getReplicaDatabase: () => ({}),
}));
vi.mock('@/api/powersync/localTags', () => ({
  listLocalTags: async () => h.tags,
}));
vi.mock('@/components/MemoryHub', () => ({
  MemoryHubShell: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

import { LocalTagsList } from './LocalTagsList';

describe('LocalTagsList', () => {
  it("lists the phone's tags with their counts, linking each to the Memory list filtered to it", async () => {
    h.tags = [
      { id: 't1', label: 'Travel', description: 'Trips and flights', entityCount: 12 },
      { id: 't2', label: 'work', description: null, entityCount: 1 },
    ];
    renderWithProviders(<LocalTagsList />, { route: '/memory/tags' });

    expect(await screen.findByText('Travel')).toBeInTheDocument();
    expect(screen.getByText('12 items')).toBeInTheDocument();
    expect(screen.getByText('1 item')).toBeInTheDocument();
    expect(screen.getByTestId('local-tags-caption')).toHaveTextContent('Saved on this phone');
    expect(screen.getByText('Travel').closest('a')).toHaveAttribute('href', '/memory?tags=Travel');
    // Rename and delete are server writes; the offline page offers neither.
    expect(screen.queryByLabelText(/Actions for|Edit |Delete /)).not.toBeInTheDocument();
  });

  it("filters by the header box's search like the appliance's page", async () => {
    h.tags = [
      { id: 't1', label: 'Travel', description: null, entityCount: 2 },
      { id: 't2', label: 'work', description: null, entityCount: 1 },
    ];
    renderWithProviders(<LocalTagsList />, { route: '/memory/tags?search=tra' });

    expect(await screen.findByText('Travel')).toBeInTheDocument();
    expect(screen.queryByText('work')).not.toBeInTheDocument();
  });
});
