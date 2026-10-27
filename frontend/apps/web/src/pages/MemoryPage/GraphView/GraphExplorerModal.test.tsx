import { setApiKey } from '@ci/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphLink, GraphNode } from '@/api/useGraphOverview';

import { GraphTabPanel } from './GraphExplorerModal';

/**
 * The webbed-feet spike's interaction contract, end to end over mocked graph APIs:
 * select a node → info dialog; Focus → /api/graph/node subgraph with a return control;
 * select a link → connection-thread dialog; background click → everything resets.
 */

const node = (id: string, name: string): GraphNode => ({
  id,
  entity_id: id,
  entity_type: 'PersonType',
  name,
  description: `${name} description`,
  properties: {},
});

const link = (id: string, source: string, target: string, strength = 0.8): GraphLink => ({
  id,
  relationship_id: id,
  source,
  target,
  relationship_type: 'KNOWS_WELL',
  strength,
  properties: { since: '2019' },
});

const OVERVIEW = {
  nodes: [
    node('user-1', 'Owner Person'),
    node('friend-1', 'Frida Friend'),
    node('friend-2', 'Colm Colleague'),
  ],
  links: [link('rel-1', 'user-1', 'friend-1'), link('rel-2', 'friend-1', 'friend-2')],
};

// Frida's focus fetch: Dora is her own connection (1 hop); Rex hangs off Dora (2 hops), which the
// focus view keeps on screen as a receding context dot rather than a full member of her graph.
const FOCUS_SUBGRAPH = {
  nodes: [node('friend-1', 'Frida Friend'), node('distant-1', 'Dora Distant'), node('ring-1', 'Rex Ring')],
  links: [link('rel-3', 'friend-1', 'distant-1'), link('rel-4', 'distant-1', 'ring-1')],
};

const useNodeGraphServiceMock = vi.fn();
const useGraphDotsMock = vi.fn();
const setActiveEntityMock = vi.fn();
const resolveNodeEntityMock = vi.fn();

// The web session holds a JWT. The native shell holds only a device API key, so there is no JWT
// there (`authToken` null) while the session is still `authenticated`.
const authState = vi.hoisted(() => ({ authToken: 'test-token' as string | null, authenticated: true }));

vi.mock('@/hooks', () => ({
  useAuth: () => [authState],
}));

vi.mock('@/pages/MemoryPage/useEntityService', () => ({
  useEntityService: () => [{}, { setActiveEntity: setActiveEntityMock }],
}));

vi.mock('@/pages/MemoryPage/Components', () => ({
  Empty: ({ title }: { title: string }) => <div>{title}</div>,
  ErrorState: ({ description, onRetry }: { description?: string; onRetry?: () => void }) => (
    <div role="alert">
      <p>{description}</p>
      {onRetry && <button onClick={onRetry}>Try again</button>}
    </div>
  ),
}));

vi.mock('@/components/SearchBox/useDropdown', () => ({
  AVAILABLE_ENTITY_TYPES: ['Person', 'Place'],
}));

vi.mock('@/api/useGraphOverview', () => ({
  useGraphOverview: () => ({
    loading: false,
    error: null,
    subgraph: OVERVIEW,
    userEntityId: 'user-1',
    quickStats: null,
    currentUser: null,
    filterMatchedEntityIds: null,
    filterScope: { tags: false, events: false },
  }),
}));

vi.mock('@/api/useNodeGraphService', () => ({
  useNodeGraphService: (props: { entityId?: string; skip?: boolean }) => useNodeGraphServiceMock(props),
}));

vi.mock('@/api/useGraphDots', () => ({
  useGraphDots: (_token: unknown, options: { skip?: boolean }) => useGraphDotsMock(options),
}));

vi.mock('./useGraphNodeEntity', () => ({
  useGraphNodeEntity: () => ({ resolveNodeEntity: resolveNodeEntityMock, resolving: false }),
}));

// The 3D renderer needs WebGL, which jsdom does not have. The stub records the graph it was
// handed so the toggle tests can assert the same data flows to either renderer.
vi.mock('./GraphCanvas3D', () => ({
  default: ({ nodes, links }: { nodes: GraphNode[]; links: GraphLink[] }) => (
    <div data-testid="graph-canvas-3d" data-node-count={nodes.length} data-link-count={links.length} />
  ),
}));

/**
 * The classic-overview tests pin a date filter in the URL: any restrictive
 * filter (dates, tags, who/where, …) makes the explorer resolve through
 * /graph/data — the contract these tests cover. The unfiltered default now
 * takes the dots path instead, covered by its own block below.
 */
function shell(initialEntries: string[] = ['/?from=2024-01-01']) {
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <GraphTabPanel variant="desktop" />
    </MemoryRouter>
  );
}

function renderShell(initialEntries?: string[]) {
  return render(shell(initialEntries));
}

async function nodeGroup(name: string) {
  await waitFor(() => {
    expect(screen.getAllByTestId('force-node').length).toBeGreaterThan(0);
  });

  const group = screen
    .getAllByTestId('force-node')
    .find((candidate) => candidate.querySelector('title')?.textContent?.startsWith(name));

  expect(group).toBeDefined();

  return group!;
}

describe('GraphTabPanel (webbed-feet spike)', () => {
  const realRequestAnimationFrame = globalThis.requestAnimationFrame;
  const realCancelAnimationFrame = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    // Same pacing trick as ForceGraph.test.tsx: run the rAF-driven simulation on the macrotask
    // queue so the layout settles inside the test budget.
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0)) as unknown as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number) =>
      clearTimeout(handle)) as unknown as typeof cancelAnimationFrame;

    useNodeGraphServiceMock.mockImplementation(({ entityId, skip }) =>
      skip || !entityId
        ? { data: null, loading: false, error: null, refresh: vi.fn() }
        : { data: FOCUS_SUBGRAPH, loading: false, error: null, refresh: vi.fn() },
    );

    useGraphDotsMock.mockReturnValue({
      loading: false,
      error: null,
      nodes: [],
      userEntityId: null,
      counts: {},
      truncated: false,
    });

    // The resolver hands back the node's REAL entity — a typed PersonType, not the graph's
    // name-and-type stub. Its own contract (and the fallback) is covered in useGraphNodeEntity.
    resolveNodeEntityMock.mockImplementation(async (node: GraphNode) => ({
      __typename: 'PersonType',
      id: `person-${node.id}`,
      tags: [],
    }));
  });

  afterEach(() => {
    authState.authToken = 'test-token';
    authState.authenticated = true;
    setApiKey(null);
    globalThis.requestAnimationFrame = realRequestAnimationFrame;
    globalThis.cancelAnimationFrame = realCancelAnimationFrame;
    useNodeGraphServiceMock.mockReset();
    useGraphDotsMock.mockReset();
    setActiveEntityMock.mockReset();
    resolveNodeEntityMock.mockReset();
    localStorage.removeItem('ci-graph-view-dimension');
  });

  it('renders the overview graph with its stats line', async () => {
    renderShell();

    await waitFor(() => {
      expect(screen.getAllByTestId('force-node')).toHaveLength(OVERVIEW.nodes.length);
    });

    expect(screen.getByText(/3\s+shown\s+·\s+2 connections/)).toBeInTheDocument();
    expect(screen.queryByTestId('graph-back-to-overview')).not.toBeInTheDocument();
  });

  it('opens the entity info dialog on node selection', async () => {
    renderShell();

    fireEvent.click(await nodeGroup('Frida Friend'));

    const dialog = await screen.findByTestId('entity-info-dialog');

    expect(dialog).toHaveTextContent('Frida Friend');
    expect(dialog).toHaveTextContent('Frida Friend description');
    // Both of Frida's relationships are listed as connections.
    expect(dialog).toHaveTextContent('Owner Person');
    expect(dialog).toHaveTextContent('Colm Colleague');
  });

  // A graph node used to reach the drawer as a synthetic `GenericEntity` carrying only its name
  // and type, which rendered a stub with nothing to browse to. It now resolves to the real typed
  // entity first, so the sheet shows the same body List and Gallery show.
  it('resolves the node to its real entity before opening the shared details sheet', async () => {
    renderShell();

    fireEvent.click(await nodeGroup('Frida Friend'));
    fireEvent.click(await screen.findByRole('button', { name: /details/i }));

    await waitFor(() => {
      expect(resolveNodeEntityMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'friend-1' }));
      expect(setActiveEntityMock).toHaveBeenCalledWith(
        expect.objectContaining({ __typename: 'PersonType', id: 'person-friend-1' }),
      );
    });

    // The stub is no longer what the drawer receives.
    expect(setActiveEntityMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ __typename: 'GenericEntity' }),
    );
  });

  it('falls back to the graph node card when the entity cannot be resolved', async () => {
    resolveNodeEntityMock.mockImplementation(async (node: GraphNode) => ({
      __typename: 'GenericEntity',
      id: node.id,
      name: node.name,
      entityType: node.entity_type,
      description: node.description,
      properties: node.properties,
    }));

    renderShell();

    fireEvent.click(await nodeGroup('Frida Friend'));
    fireEvent.click(await screen.findByRole('button', { name: /details/i }));

    await waitFor(() => {
      expect(setActiveEntityMock).toHaveBeenCalledWith(
        expect.objectContaining({ __typename: 'GenericEntity', id: 'friend-1', name: 'Frida Friend' }),
      );
    });
  });

  it('enters focus mode from the dialog and returns to the overview', async () => {
    renderShell();

    fireEvent.click(await nodeGroup('Frida Friend'));
    fireEvent.click(await screen.findByRole('button', { name: /focus/i }));

    // Focus mode swaps in the /api/graph/node subgraph and shows the return control.
    await waitFor(() => {
      expect(useNodeGraphServiceMock).toHaveBeenCalledWith(
        expect.objectContaining({ entityId: 'friend-1', skip: false }),
      );
      expect(screen.getByTestId('graph-back-to-overview')).toBeInTheDocument();
    });

    await nodeGroup('Dora Distant');
    expect(screen.getByText(/3\s+shown\s+·\s+2 connections/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('graph-back-to-overview'));

    await waitFor(() => {
      expect(screen.queryByTestId('graph-back-to-overview')).not.toBeInTheDocument();
      expect(screen.getAllByTestId('force-node')).toHaveLength(OVERVIEW.nodes.length);
    });
  });

  it('draws the neighbourhood beyond the focused entity as unlabelled context dots', async () => {
    renderShell();

    fireEvent.click(await nodeGroup('Frida Friend'));
    fireEvent.click(await screen.findByRole('button', { name: /focus/i }));

    // Dora is Frida's own connection: full weight, named. Rex is two hops out: a context dot —
    // still on screen and still clickable, but faded, smaller and unlabelled.
    const own = await nodeGroup('Dora Distant');
    const ring = await nodeGroup('Rex Ring');

    expect(own).not.toHaveAttribute('data-context');
    expect(ring).toHaveAttribute('data-context', 'true');
    expect(ring.querySelector('text')?.textContent ?? '').toBe('');
    expect(Number.parseFloat(ring.getAttribute('opacity') ?? '1')).toBeLessThan(1);
  });

  it('opens the connection-thread dialog on link selection', async () => {
    renderShell();

    await waitFor(() => {
      expect(screen.getAllByTestId('force-link').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByTestId('force-link')[0]);

    const dialog = await screen.findByTestId('connection-thread-dialog');

    expect(dialog).toHaveTextContent('Knows Well');
    expect(dialog).toHaveTextContent('80%');
    expect(dialog).toHaveTextContent('since');

    // The graph marks the selected thread.
    expect(
      screen.getAllByTestId('force-link').filter((group) => group.getAttribute('data-selected') === 'true'),
    ).toHaveLength(1);
  });

  it('switches to the 3D renderer and back, remembering the choice', async () => {
    renderShell();

    // 2D SVG by default; no 3D canvas mounted (nor its three.js bundle loaded). The toggle is a
    // single button labelled with the dimension it switches TO.
    await waitFor(() => {
      expect(screen.getAllByTestId('force-node')).toHaveLength(OVERVIEW.nodes.length);
    });
    expect(screen.queryByTestId('graph-canvas-3d')).not.toBeInTheDocument();

    const toggle = screen.getByTestId('graph-dimension-toggle');

    expect(toggle).toHaveTextContent('3D');

    fireEvent.click(toggle);

    // Same display graph, different renderer; the toggle now offers the way back.
    const canvas3d = await screen.findByTestId('graph-canvas-3d');

    expect(canvas3d).toHaveAttribute('data-node-count', String(OVERVIEW.nodes.length));
    expect(canvas3d).toHaveAttribute('data-link-count', String(OVERVIEW.links.length));
    expect(screen.queryAllByTestId('force-node')).toHaveLength(0);
    expect(localStorage.getItem('ci-graph-view-dimension')).toBe('3d');
    expect(toggle).toHaveTextContent('2D');

    // The shell chrome — stats line and legend — stays up over either renderer.
    expect(screen.getByText(/3\s+shown\s+·\s+2 connections/)).toBeInTheDocument();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(screen.getAllByTestId('force-node')).toHaveLength(OVERVIEW.nodes.length);
    });
    expect(screen.queryByTestId('graph-canvas-3d')).not.toBeInTheDocument();
    expect(localStorage.getItem('ci-graph-view-dimension')).toBe('2d');
    expect(toggle).toHaveTextContent('3D');
  });

  it('clears dialogs on a background click', async () => {
    renderShell();

    fireEvent.click(await nodeGroup('Frida Friend'));
    await screen.findByTestId('entity-info-dialog');

    fireEvent.click(screen.getByRole('img', { name: 'Knowledge graph overview' }));

    await waitFor(() => {
      expect(screen.queryByTestId('entity-info-dialog')).not.toBeInTheDocument();
    });
  });

  /**
   * Graph search used to ask for 10 nodes and re-slice to 20 with nothing said about the rest,
   * so a query that matched thousands answered with a dozen dots. It now asks for the full
   * canvas budget and says so when the corpus had more.
   */
  describe('search mode', () => {
    const realFetch = globalThis.fetch;

    function mockSearchResponse(payload: Record<string, unknown>) {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => ({
        url: String(input),
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => payload,
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      return fetchMock;
    }

    const FRIDA_RESULT = {
      success: true,
      nodes: [{ entity_id: 'friend-1', entity_type: 'Person', name: 'Frida Friend' }],
      links: [],
      limit: 150,
      truncated: false,
    };

    /** The headers the first search request went out with, as a plain object. */
    const searchHeaders = (fetchMock: ReturnType<typeof mockSearchResponse>) =>
      fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;

    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('requests the full canvas budget rather than a token page', async () => {
      const fetchMock = mockSearchResponse({
        success: true,
        nodes: [{ entity_id: 'friend-1', entity_type: 'Person', name: 'Frida Friend' }],
        links: [],
        limit: 150,
        truncated: false,
      });

      renderShell(['/?search=frida']);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      const url = String(fetchMock.mock.calls[0]?.[0]);

      expect(url).toContain('/api/graph/search');
      expect(url).toContain('limit=150');
      expect(await screen.findByTestId('graph-search-chip')).toHaveTextContent('frida');
      expect(screen.queryByTestId('graph-search-truncated')).not.toBeInTheDocument();
    });

    it('tells the user when the query matched more than the canvas drew', async () => {
      mockSearchResponse({
        success: true,
        nodes: [{ entity_id: 'friend-1', entity_type: 'Person', name: 'Frida Friend' }],
        links: [],
        limit: 150,
        truncated: true,
      });

      renderShell(['/?search=frida']);

      expect(await screen.findByTestId('graph-search-truncated')).toBeInTheDocument();
    });

    it('searches with the bearer on the web', async () => {
      const fetchMock = mockSearchResponse(FRIDA_RESULT);

      renderShell(['/?search=frida']);

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(searchHeaders(fetchMock).Authorization).toBe('Bearer test-token');
    });

    /**
     * ═══ "AUTHENTICATION REQUIRED FOR GRAPH SEARCH" ON THE PHONE ═══
     *
     * `authToken` is the web JWT, null in the Capacitor app — whose durable credential is a
     * keystore API key. The search effect refused before it asked, so every graph search on the
     * phone ended in that message for a signed-in person. `GET /graph/search` is
     * `JwtOrApiKeyAuthGuard`, and the request already carries the key; it also sent
     * `Authorization: Bearer null`, which is dropped here.
     */
    describe('native shell (API key, no web JWT)', () => {
      beforeEach(() => {
        authState.authToken = null;
        setApiKey('device-key');
      });

      it('searches with the device key and no bearer, and draws the result', async () => {
        const fetchMock = mockSearchResponse(FRIDA_RESULT);

        renderShell(['/?search=frida']);

        await waitFor(() => expect(fetchMock).toHaveBeenCalled());

        const headers = searchHeaders(fetchMock);
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/graph/search');
        expect(headers['x-api-key']).toBe('device-key');
        expect(headers).not.toHaveProperty('Authorization');

        expect(await screen.findByTestId('graph-search-chip')).toHaveTextContent('frida');
        expect(screen.queryByText('Authentication required for graph search.')).not.toBeInTheDocument();
      });
    });

    it('still says authentication is required when nobody is signed in, and asks nothing', async () => {
      authState.authToken = null;
      authState.authenticated = false;
      const fetchMock = mockSearchResponse(FRIDA_RESULT);

      renderShell(['/?search=frida']);

      expect(await screen.findByText('Authentication required for graph search.')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('dots overview (no restrictive filters)', () => {
    const DOT_NODES = [
      { ...node('user-1', 'Owner Person'), degree: 5 },
      { ...node('friend-1', 'Frida Friend'), degree: 2 },
      { ...node('event-1', 'Coffee Meetup'), entity_type: 'Event', event_type: 'meeting', degree: 1 },
    ];

    beforeEach(() => {
      useGraphDotsMock.mockReturnValue({
        loading: false,
        error: null,
        nodes: DOT_NODES,
        userEntityId: 'user-1',
        counts: { PersonType: 2, Event: 1 },
        truncated: false,
      });
    });

    it('renders the dots payload and skips the classic overview fetch', async () => {
      renderShell(['/']);

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node')).toHaveLength(DOT_NODES.length);
      });

      // The dots hook is live (skip false) precisely when no restrictive filter is set.
      expect(useGraphDotsMock).toHaveBeenCalledWith(expect.objectContaining({ skip: false }));
      // No edges ship with the dots payload; they arrive via focus/section fetches.
      expect(screen.queryAllByTestId('force-link')).toHaveLength(0);
    });

    it('shows a plain message with Try again, not the raw error, and refetches on retry', async () => {
      // One stable object per state, like the hook's memoised result: a fresh
      // `counts` object on every render re-runs the explorer's effects forever.
      const loaded = {
        loading: false,
        error: null,
        nodes: DOT_NODES,
        userEntityId: 'user-1',
        counts: { PersonType: 2, Event: 1 },
        truncated: false,
      };
      const failed = {
        loading: false,
        error: 'Fetch failed: 500 Internal Server Error',
        nodes: [],
        userEntityId: null,
        counts: {},
        truncated: false,
      };

      useGraphDotsMock.mockImplementation((options: { refreshKey?: number }) =>
        options.refreshKey ? loaded : failed,
      );

      renderShell(['/']);

      expect(
        await screen.findByText("We couldn't load your graph. Check your connection and try again."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Fetch failed/)).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node')).toHaveLength(DOT_NODES.length);
      });
      expect(useGraphDotsMock).toHaveBeenCalledWith(expect.objectContaining({ refreshKey: 1 }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('preloads edges among busy dots when switching to 3D overview', async () => {
      // `init` is declared even though the mock ignores it: the assertion below
      // reads `edgeCall[1]` to check the POSTed body, and vi.fn types its
      // `mock.calls` from this signature — a one-parameter mock makes that a
      // 1-tuple and the read a type error.
      const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('/api/graph/edges')) {
          return {
            ok: true,
            json: async () => ({
              data: { links: [link('rel-dot', 'user-1', 'friend-1')] },
            }),
          };
        }

        return { ok: false, json: async () => ({}) };
      });
      const previousFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        renderShell(['/']);
        fireEvent.click(screen.getByTestId('graph-dimension-toggle'));

        const canvas3d = await screen.findByTestId('graph-canvas-3d');
        expect(canvas3d).toBeInTheDocument();

        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalled();
          expect(screen.getByTestId('graph-canvas-3d')).toHaveAttribute('data-link-count', '1');
        });

        const edgeCall = fetchMock.mock.calls.find(([input]) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

          return url.includes('/api/graph/edges');
        });
        expect(edgeCall).toBeDefined();
        const body = JSON.parse(String(edgeCall![1]?.body)) as { ids: string[] };
        expect(body.ids[0]).toBe('user-1');
      } finally {
        globalThis.fetch = previousFetch;
      }
    });

    it('opens the clicked dot’s card once its neighbourhood has loaded', async () => {
      // The real fetch takes a moment; until it lands the focus canvas is empty, and the
      // selection must survive that wait for the card to open.
      let focusLoaded = false;

      useNodeGraphServiceMock.mockImplementation(({ entityId, skip }) =>
        skip || !entityId
          ? { data: null, loading: false, error: null, refresh: vi.fn() }
          : focusLoaded
            ? { data: FOCUS_SUBGRAPH, loading: false, error: null, refresh: vi.fn() }
            : { data: null, loading: true, error: null, refresh: vi.fn() },
      );

      const { rerender } = renderShell(['/']);

      fireEvent.click(await nodeGroup('Frida Friend'));

      await waitFor(() => expect(screen.getByTestId('graph-back-to-overview')).toBeInTheDocument());
      expect(screen.queryByTestId('entity-info-dialog')).not.toBeInTheDocument();

      focusLoaded = true;
      rerender(shell(['/']));

      expect(await screen.findByTestId('entity-info-dialog')).toHaveTextContent('Frida Friend');
    });

    it('opens the second clicked dot’s card too, after a trip back to the overview', async () => {
      // useNodeGraphService keeps the last subgraph it fetched until the next one lands, so the
      // second focus waits on Frida's neighbourhood, not on nothing.
      const EVENT_SUBGRAPH = {
        nodes: [
          { ...node('event-1', 'Coffee Meetup'), entity_type: 'Event' },
          node('user-1', 'Owner Person'),
        ],
        links: [link('rel-5', 'user-1', 'event-1')],
      };
      const subgraphs: Record<string, typeof FOCUS_SUBGRAPH> = {
        'friend-1': FOCUS_SUBGRAPH,
        'event-1': EVENT_SUBGRAPH,
      };
      const loaded = new Set(['friend-1']);
      let lastData: typeof FOCUS_SUBGRAPH | null = null;

      useNodeGraphServiceMock.mockImplementation(({ entityId, skip }) => {
        if (!skip && entityId && loaded.has(entityId)) {
          lastData = subgraphs[entityId];

          return { data: lastData, loading: false, error: null, refresh: vi.fn() };
        }

        return { data: lastData, loading: !skip && Boolean(entityId), error: null, refresh: vi.fn() };
      });

      const { rerender } = renderShell(['/']);

      fireEvent.click(await nodeGroup('Frida Friend'));
      expect(await screen.findByTestId('entity-info-dialog')).toHaveTextContent('Frida Friend');

      fireEvent.click(screen.getByTestId('graph-back-to-overview'));
      await waitFor(() => expect(screen.queryByTestId('graph-back-to-overview')).not.toBeInTheDocument());

      fireEvent.click(await nodeGroup('Coffee Meetup'));
      await waitFor(() => expect(screen.getByTestId('graph-back-to-overview')).toBeInTheDocument());
      expect(screen.queryByTestId('entity-info-dialog')).not.toBeInTheDocument();

      loaded.add('event-1');
      rerender(shell(['/']));

      expect(await screen.findByTestId('entity-info-dialog')).toHaveTextContent('Coffee Meetup');
    });

    it('expands a clicked dot straight into focus mode', async () => {
      renderShell(['/']);

      fireEvent.click(await nodeGroup('Frida Friend'));

      // Clicking a dot IS the focus gesture in the dots overview: no dialog
      // stopover, the node's neighbourhood loads immediately.
      await waitFor(() => {
        expect(useNodeGraphServiceMock).toHaveBeenCalledWith(
          expect.objectContaining({ entityId: 'friend-1', skip: false }),
        );
        expect(screen.getByTestId('graph-back-to-overview')).toBeInTheDocument();
      });
    });
  });
});
