import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Subgraph } from '@/api/useNodeGraphService';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ConnectionsSection } from './ConnectionsSection';

const useNodeGraphServiceMock = vi.fn();

vi.mock('@/api/useNodeGraphService', () => ({
  useNodeGraphService: (props: unknown) => useNodeGraphServiceMock(props),
}));

// AddRelationshipModal is always mounted (just visually hidden) and reaches
// for search on every render — stub it the same way its own tests do.
vi.mock('@/components/SearchBox/useSearchService.ts', () => ({
  useSearchService: () => ({ data: [], loading: false, error: null }),
}));

const ENTITY_ID = 'self-entity-1';

function node(id: string, name: string, entityType = 'person') {
  return { id, entity_id: id, entity_type: entityType, name, description: null, properties: {} };
}

function link(id: string, target: string, relationshipType: string) {
  return {
    id,
    relationship_id: id,
    source: ENTITY_ID,
    target,
    relationship_type: relationshipType,
    strength: 0.5,
    properties: {},
  };
}

const SUBGRAPH: Subgraph = {
  nodes: [node(ENTITY_ID, 'Me'), node('friend-1', 'Frida Friend'), node('spouse-1', 'Sam Spouse')],
  links: [link('rel-friend', 'friend-1', 'FRIENDS_WITH'), link('rel-spouse', 'spouse-1', 'SPOUSE')],
};

describe('ConnectionsSection', () => {
  beforeEach(() => {
    useNodeGraphServiceMock.mockReset();
    useNodeGraphServiceMock.mockReturnValue({ data: SUBGRAPH, loading: false, error: null });
  });

  it('shows non-family connections but not the family edge AboutYouSection already covers', () => {
    renderWithProviders(<ConnectionsSection entityId={ENTITY_ID} />);

    expect(screen.getByText('Frida Friend')).toBeInTheDocument();
    expect(screen.queryByText('Sam Spouse')).not.toBeInTheDocument();
  });

  it('opens the Add relationship modal from its own button', () => {
    renderWithProviders(<ConnectionsSection entityId={ENTITY_ID} />);

    fireEvent.click(screen.getByRole('button', { name: /add relationship/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
