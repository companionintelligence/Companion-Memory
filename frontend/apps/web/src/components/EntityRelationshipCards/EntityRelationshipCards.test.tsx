import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Subgraph } from '@/api/useNodeGraphService';
import { renderWithProviders } from '@/test/renderWithProviders';

import { EntityRelationshipCards } from './EntityRelationshipCards';

const useNodeGraphServiceMock = vi.fn();

vi.mock('@/api/useNodeGraphService', () => ({
  useNodeGraphService: (props: unknown) => useNodeGraphServiceMock(props),
}));

const FOCUS_ID = 'user-1';

const SUBGRAPH: Subgraph = {
  nodes: [
    {
      id: FOCUS_ID,
      entity_id: FOCUS_ID,
      entity_type: 'person',
      name: 'Me',
      description: null,
      properties: {},
    },
    {
      id: 'friend-1',
      entity_id: 'friend-1',
      entity_type: 'person',
      name: 'Frida Friend',
      description: 'A friend from work',
      properties: {},
    },
  ],
  links: [
    {
      id: 'rel-1',
      relationship_id: 'rel-1',
      source: FOCUS_ID,
      target: 'friend-1',
      relationship_type: 'KNOWS',
      strength: 0.9,
      properties: {},
    },
  ],
};

function renderCards(entityId = FOCUS_ID) {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<EntityRelationshipCards entityId={entityId} />} />
      <Route path="/people/:id" element={<div>Person detail page</div>} />
    </Routes>,
  );
}

describe('EntityRelationshipCards', () => {
  beforeEach(() => {
    useNodeGraphServiceMock.mockReset();
    useNodeGraphServiceMock.mockReturnValue({ data: SUBGRAPH, loading: false, error: null });
  });

  it('renders a card for the related entity with a human relationship, not the raw edge type', () => {
    renderCards();

    expect(screen.getByText('Frida Friend')).toBeInTheDocument();
    expect(screen.getByText('Someone you know')).toBeInTheDocument();
    expect(screen.getByText('Person')).toBeInTheDocument();
    expect(screen.getByText('A friend from work')).toBeInTheDocument();
    expect(screen.queryByText('KNOWS')).not.toBeInTheDocument();
    expect(screen.queryByText('PERSON')).not.toBeInTheDocument();
  });

  it('navigates to the related entity route when a card is clicked', async () => {
    renderCards();

    // The whole card is the <Link> — clicking the neighbor's name should route to their page.
    fireEvent.click(screen.getByText('Frida Friend'));

    expect(await screen.findByText('Person detail page')).toBeInTheDocument();
  });

  it('renders nothing once loading is done and there are no relationships', () => {
    useNodeGraphServiceMock.mockReturnValue({ data: { nodes: [], links: [] }, loading: false, error: null });

    const { container } = renderCards();

    expect(container).toBeEmptyDOMElement();
  });

  it('shows loading skeleton cards instead of neighbor data while the fetch is in flight', () => {
    useNodeGraphServiceMock.mockReturnValue({ data: null, loading: true, error: null });

    renderCards();

    expect(screen.queryByText('Frida Friend')).not.toBeInTheDocument();
    expect(screen.getByText('Connections')).toBeInTheDocument();
  });

  it('does not wrap a card in a Link when the neighbor type has no detail route', async () => {
    useNodeGraphServiceMock.mockReturnValue({
      data: {
        nodes: [
          SUBGRAPH.nodes[0],
          {
            id: 'thread-1',
            entity_id: 'thread-1',
            entity_type: 'unknown-kind',
            name: 'Mystery Thread',
            description: null,
            properties: {},
          },
        ],
        links: [
          {
            id: 'rel-2',
            relationship_id: 'rel-2',
            source: FOCUS_ID,
            target: 'thread-1',
            relationship_type: 'RELATES_TO',
            strength: 0.4,
            properties: {},
          },
        ],
      },
      loading: false,
      error: null,
    });

    renderCards();

    await waitFor(() => expect(screen.getByText('Mystery Thread')).toBeInTheDocument());
    expect(screen.getByText('Mystery Thread').closest('a')).toBeNull();
  });

  it('filters cards down to the given relationship types', () => {
    useNodeGraphServiceMock.mockReturnValue({
      data: {
        nodes: SUBGRAPH.nodes,
        links: [
          SUBGRAPH.links[0], // KNOWS
          { id: 'rel-3', relationship_id: 'rel-3', source: FOCUS_ID, target: 'friend-1', relationship_type: 'SPOUSE', strength: 0.9, properties: {} },
        ],
      },
      loading: false,
      error: null,
    });

    renderWithProviders(
      <Routes>
        <Route
          path="/"
          element={<EntityRelationshipCards entityId={FOCUS_ID} relationshipTypes={['KNOWS']} />}
        />
      </Routes>,
    );

    // Both edges point at the same neighbor, so a card per surviving edge is
    // the only way to tell "filtered" from "coincidentally deduped" apart —
    // one card means SPOUSE was dropped, not that it rendered and got merged.
    expect(screen.getAllByText('Frida Friend')).toHaveLength(1);
  });

  it('filters cards down to the given neighbor entity types', () => {
    useNodeGraphServiceMock.mockReturnValue({
      data: {
        nodes: [
          SUBGRAPH.nodes[0],
          SUBGRAPH.nodes[1],
          { id: 'place-1', entity_id: 'place-1', entity_type: 'place', name: 'Home', description: null, properties: {} },
        ],
        links: [
          SUBGRAPH.links[0],
          { id: 'rel-4', relationship_id: 'rel-4', source: FOCUS_ID, target: 'place-1', relationship_type: 'LIVES_IN', strength: 1, properties: {} },
        ],
      },
      loading: false,
      error: null,
    });

    renderWithProviders(
      <Routes>
        <Route path="/" element={<EntityRelationshipCards entityId={FOCUS_ID} entityTypes={['person']} />} />
      </Routes>,
    );

    expect(screen.getByText('Frida Friend')).toBeInTheDocument();
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
  });

  it('uses a custom heading when given one', () => {
    renderWithProviders(
      <Routes>
        <Route path="/" element={<EntityRelationshipCards entityId={FOCUS_ID} heading="Friends & Connections" />} />
      </Routes>,
    );

    expect(screen.getByText('Friends & Connections')).toBeInTheDocument();
    expect(screen.queryByText('Connections')).not.toBeInTheDocument();
  });

  it('does not dump connection ids, normalize leftovers, or Gmail system labels', () => {
    useNodeGraphServiceMock.mockReturnValue({
      data: {
        nodes: [
          SUBGRAPH.nodes[0],
          {
            id: 'bennett-1',
            entity_id: 'bennett-1',
            entity_type: 'PERSON',
            name: 'bennett',
            description: null,
            properties: {},
          },
          {
            id: 'comm-1',
            entity_id: 'comm-1',
            entity_type: 'COMMUNICATION',
            name: 'Order complete: Reverb — The Vinyl Factory',
            description: 'Your order has shipped.',
            properties: {
              type: 'email',
              tags: ['COMMUNICATION', 'IMPORTANT', 'INBOX', 'CATEGORY_PERSONAL', 'vinyl'],
            },
          },
        ],
        links: [
          {
            id: 'rel-mail',
            relationship_id: 'rel-mail',
            source: 'bennett-1',
            target: FOCUS_ID,
            relationship_type: 'EMAILED',
            strength: 0.8,
            properties: {
              connection_id: '019fb4ad-1456-761c-bd32-a2b263e81e02',
              normalized_from: 'RECEIVED_EMAIL_FROM',
            },
          },
          {
            id: 'rel-comm',
            relationship_id: 'rel-comm',
            source: FOCUS_ID,
            target: 'comm-1',
            relationship_type: 'RECEIVED',
            strength: 0.7,
            properties: {},
          },
        ],
      },
      loading: false,
      error: null,
    });

    renderCards();

    expect(screen.getByText('bennett')).toBeInTheDocument();
    expect(screen.getByText('Emailed you')).toBeInTheDocument();
    expect(screen.getByText('Order complete: Reverb — The Vinyl Factory')).toBeInTheDocument();
    expect(screen.getByText('You received this')).toBeInTheDocument();
    expect(screen.getByText('Your order has shipped.')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('vinyl')).toBeInTheDocument();

    expect(screen.queryByText(/Connection Id/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/019fb4ad-1456-761c-bd32-a2b263e81e02/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Normalized From/i)).not.toBeInTheDocument();
    expect(screen.queryByText('RECEIVED_EMAIL_FROM')).not.toBeInTheDocument();
    expect(screen.queryByText('IMPORTANT')).not.toBeInTheDocument();
    expect(screen.queryByText('INBOX')).not.toBeInTheDocument();
    expect(screen.queryByText('CATEGORY_PERSONAL')).not.toBeInTheDocument();
    expect(screen.queryByText('COMMUNICATION')).not.toBeInTheDocument();
  });

  it('clips long titles and tags inside the card instead of hanging off the tile', () => {
    useNodeGraphServiceMock.mockReturnValue({
      data: {
        nodes: [
          SUBGRAPH.nodes[0],
          {
            id: 'comm-long',
            entity_id: 'comm-long',
            entity_type: 'communication',
            name: 'Order complete: Reverb — The Vinyl Factory plus a very long leftover subject',
            description: null,
            properties: { tags: ['a-very-long-collector-label-that-used-to-overflow'] },
          },
        ],
        links: [
          {
            id: 'rel-long',
            relationship_id: 'rel-long',
            source: FOCUS_ID,
            target: 'comm-long',
            relationship_type: 'RECEIVED',
            strength: 0.5,
            properties: {},
          },
        ],
      },
      loading: false,
      error: null,
    });

    renderCards();

    const title = screen.getByText(/Order complete: Reverb/);
    const card = title.closest('[data-slot="card"]');
    expect(card).toHaveClass('overflow-hidden');
    expect(card).toHaveClass('min-w-0');

    const tag = screen.getByText('a-very-long-collector-label-that-used-to-overflow');
    expect(tag.closest('[data-slot="badge"], .flex.items-center')).toBeTruthy();
    expect(tag.parentElement).toHaveClass('max-w-full');
    expect(tag.parentElement).toHaveClass('truncate');
  });
});
