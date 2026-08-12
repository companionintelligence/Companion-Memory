import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphLink, GraphNode } from '@/api/useGraphOverview';

import { ForceGraph } from './ForceGraph';
import { LABEL_GAP_PX, LABEL_HALF_HEIGHT_PX, labelWidthPx, truncateLabel } from './labelLayout';

/**
 * The reported defect, end to end: a person's 2-hop graph rendered its neighbours' names four deep
 * in the same spot. `labelLayout.node.test.ts` covers the geometry; this covers the wiring — that
 * ForceGraph actually feeds the renderer's boxes to the separation pass.
 */

const NAMES = [
  'Aqsa Anwar',
  'Muhammad Nadeem',
  'Boris Udovicic',
  'Alexandra Hartman',
  'Abdelrahman Abdullah',
  'Amelia Guertin',
  'Logan Ryan Golema',
  'Fiona Sewell',
  'Muhammad Bilal',
  'Hassan Javid',
  'Julian Figueroa Jr',
  'Ilia Goviadko',
  'Pontus Olsson',
  'Pavlo Trots',
  'Saira Syed',
];

const CENTER_ID = 'person-center';
const HUB_ID = 'person-hub';

function buildGraph(names: string[]): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = [
    {
      id: CENTER_ID,
      entity_id: CENTER_ID,
      entity_type: 'PersonType',
      name: 'Abdul Ameer',
      description: null,
      properties: {},
    },
    ...names.map((name, index) => ({
      id: `person-${index}`,
      entity_id: `person-${index}`,
      entity_type: 'PersonType',
      name,
      description: null,
      properties: {},
    })),
  ];

  // A star around the centre, which is the shape a person page actually requests.
  const links: GraphLink[] = names.map((_, index) => ({
    id: `link-${index}`,
    relationship_id: `link-${index}`,
    source: CENTER_ID,
    target: `person-${index}`,
    relationship_type: 'KNOWS',
    strength: 0.5,
    properties: {},
  }));

  return { nodes, links };
}

/** Where a label is drawn, in the simulation's coordinate space. */
function labelBoxes() {
  return screen
    .getAllByTestId('force-node')
    .map((group) => {
      const transform = group.getAttribute('transform') ?? '';
      const match = /translate\(([-\d.]+), ([-\d.]+)\)/.exec(transform);
      const text = group.querySelector('text');
      if (!match || !text?.textContent) {
        return null;
      }

      const x = Number.parseFloat(match[1]);
      const y = Number.parseFloat(match[2]);
      const radius = Number.parseFloat(group.querySelector('circle')?.getAttribute('r') ?? '6');
      const width = Number.parseFloat(text.getAttribute('x') ?? '0') + labelWidthPx(text.textContent);
      const halfHeight = Math.max(radius, LABEL_HALF_HEIGHT_PX);

      return {
        label: text.textContent,
        left: x - radius,
        right: x + width,
        top: y - halfHeight,
        bottom: y + halfHeight,
      };
    })
    .filter((box): box is NonNullable<typeof box> => box !== null);
}

function overlappingPairs(boxes: ReturnType<typeof labelBoxes>) {
  const pairs: string[] = [];

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);

      if (overlapX > 0.5 && overlapY > 0.5) {
        pairs.push(`"${a.label}" over "${b.label}"`);
      }
    }
  }

  return pairs;
}

/** Runs the requestAnimationFrame-driven simulation to completion. */
async function settle() {
  await waitFor(() => {
    expect(screen.getAllByTestId('force-node').length).toBeGreaterThan(0);
  });

  // The simulation caps at MAX_TICKS; give it room to reach the settle + polish step.
  await waitFor(
    () => {
      expect(overlappingPairs(labelBoxes())).toEqual([]);
    },
    { timeout: 4000, interval: 25 },
  );
}

describe('ForceGraph', () => {
  const realRequestAnimationFrame = globalThis.requestAnimationFrame;
  const realCancelAnimationFrame = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    // jsdom paces requestAnimationFrame at ~16ms, so the 240-tick simulation burns ~4s of wall
    // clock — inside vitest's 5s budget on its own, and over it once the whole suite runs in
    // parallel. Ticking on the macrotask queue preserves the ordering the component relies on at a
    // fraction of the time, which is the difference between a deterministic test and a flaky one.
    //
    // Assigned directly rather than via vi.stubGlobal: `vi.unstubAllGlobals` would also drop the
    // ResizeObserver and IntersectionObserver that src/test/setup.ts stubs once for every file,
    // breaking every test after the first.
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0)) as unknown as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((handle: number) =>
      clearTimeout(handle)) as unknown as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = realRequestAnimationFrame;
    globalThis.cancelAnimationFrame = realCancelAnimationFrame;
  });

  it('renders every node with a label', async () => {
    const { nodes, links } = buildGraph(NAMES);

    render(<ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} selectedNodeId={CENTER_ID} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('force-node')).toHaveLength(nodes.length);
    });
  });

  it('leaves no two labels overlapping in a dense 16-node graph', async () => {
    const { nodes, links } = buildGraph(NAMES);

    render(<ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} selectedNodeId={CENTER_ID} />);

    await settle();

    expect(overlappingPairs(labelBoxes())).toEqual([]);
  });

  it('clips a long name and keeps the full value reachable', async () => {
    const long = 'Muhammad Abdul Mateen Al-Rahman';
    const { nodes, links } = buildGraph([long]);

    render(<ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('force-node').length).toBeGreaterThan(1);
    });

    const labels = screen.getAllByTestId('force-node').map((g) => g.querySelector('text')?.textContent);

    expect(labels).toContain(truncateLabel(long));
    expect(labels).not.toContain(long);
    // The untruncated name still has to be recoverable, via the node's <title>.
    expect(screen.getByText(new RegExp(long))).toBeInTheDocument();
  });

  it('sizes a hub larger than a leaf', async () => {
    const { nodes, links } = buildGraph(NAMES);

    render(<ForceGraph nodes={nodes} links={links} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('force-node').length).toBeGreaterThan(0);
    });

    const radii = new Map(
      screen
        .getAllByTestId('force-node')
        .map((g) => [
          g.querySelector('text')?.textContent,
          Number.parseFloat(g.querySelector('circle')?.getAttribute('r') ?? '0'),
        ]),
    );

    // The centre is linked to all 15 others; each of those has exactly one link.
    expect(radii.get('Abdul Ameer')).toBeGreaterThan(radii.get('Aqsa Anwar') ?? 0);
  });

  it('dims the nodes unrelated to the one under the pointer', async () => {
    const { nodes, links } = buildGraph(NAMES);

    render(<ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('force-node').length).toBeGreaterThan(0);
    });

    const groups = screen.getAllByTestId('force-node');
    const leaf = groups.find((g) => g.querySelector('text')?.textContent === 'Aqsa Anwar');
    const unrelated = groups.find((g) => g.querySelector('text')?.textContent === 'Fiona Sewell');

    expect(leaf).toBeDefined();
    fireEvent.pointerEnter(leaf!);

    await waitFor(() => {
      // The hovered leaf and the centre it links to stay lit; a sibling leaf fades back.
      expect(leaf).toHaveAttribute('opacity', '1');
      expect(unrelated).toHaveAttribute('opacity', '0.35');
    });
  });

  it('stops labelling every node once doing so would shrink the text', async () => {
    // Separating 60 label boxes forces the layout wider than the canvas, and the fit then scales
    // the whole picture — and its text — down to ~6px. Past the threshold only the nodes worth
    // naming keep a standing label.
    const many = Array.from({ length: 60 }, (_, i) => `Neighbour Person ${i}`);
    const { nodes, links } = buildGraph(many);

    render(<ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('force-node')).toHaveLength(nodes.length);
    });

    const drawn = screen
      .getAllByTestId('force-node')
      .filter((group) => (group.querySelector('text')?.textContent ?? '') !== '');

    expect(drawn.length).toBeLessThan(nodes.length);
    expect(drawn.length).toBeGreaterThan(0);
  });

  it('still names the centre node in a graph too dense to label fully', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `Neighbour Person ${i}`);
    const { nodes, links } = buildGraph(many);

    render(<ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} highlightedNodeId={CENTER_ID} />);

    await waitFor(() => {
      const labels = screen.getAllByTestId('force-node').map((g) => g.querySelector('text')?.textContent);

      expect(labels).toContain('Abdul Ameer');
    });
  });

  it('gives an unlabelled dot its name on hover', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `Neighbour Person ${i}`);
    const { nodes, links } = buildGraph(many);

    render(<ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('force-node')).toHaveLength(nodes.length);
    });

    const bare = screen
      .getAllByTestId('force-node')
      .find((group) => (group.querySelector('text')?.textContent ?? '') === '');

    expect(bare).toBeDefined();
    fireEvent.pointerEnter(bare!);

    await waitFor(() => {
      expect(bare!.querySelector('text')?.textContent ?? '').not.toBe('');
    });
  });

  it('does not relayout when the selection changes', async () => {
    // The graph explorer passes its live selection as highlightedNodeId. If anything selection-
    // dependent reaches the layout effect, every click restarts the simulation and throws away the
    // picture the viewer was reading.
    const { nodes, links } = buildGraph(NAMES);
    const { rerender } = render(
      <ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} highlightedNodeId={CENTER_ID} />,
    );

    await settle();

    const before = labelBoxes().map((box) => `${box.label}@${box.left.toFixed(2)},${box.top.toFixed(2)}`);

    rerender(
      <ForceGraph
        nodes={nodes}
        links={links}
        centerNodeId={CENTER_ID}
        highlightedNodeId="person-3"
        selectedNodeId="person-3"
      />,
    );

    const after = labelBoxes().map((box) => `${box.label}@${box.left.toFixed(2)},${box.top.toFixed(2)}`);

    // Only the nodes whose emphasis changed may shift — the newly emphasised one grows, the
    // formerly emphasised one gives its extra radius back. Nobody else moves: that would be the
    // relayout this test exists to forbid.
    const moved = before.filter((entry) => !after.includes(entry));

    expect(moved.length).toBeLessThanOrEqual(2);
  });

  it('keeps a label gap the renderer and the layout agree on', () => {
    // Guards the invariant the collision pass depends on: text starts at radius + LABEL_GAP_PX.
    const { nodes, links } = buildGraph(['Saira Syed']);

    render(<ForceGraph nodes={nodes} links={links} />);

    const group = screen.getAllByTestId('force-node')[0];
    const radius = Number.parseFloat(group.querySelector('circle')!.getAttribute('r')!);
    const textX = Number.parseFloat(group.querySelector('text')!.getAttribute('x')!);

    expect(textX).toBeCloseTo(radius + LABEL_GAP_PX, 5);
  });

  describe('connection threads and background clicks (webbed-feet spike)', () => {
    const nodeOpacity = (label: string) => {
      const group = screen
        .getAllByTestId('force-node')
        .find((candidate) => candidate.querySelector('title')?.textContent?.startsWith(label));

      return group?.getAttribute('opacity');
    };

    it('draws a duplicated link id once and drops self-loops', async () => {
      // Both shapes arrive from real payloads: /api/graph/node's traversal shipped each edge once
      // per BFS layer it touched. A duplicate id leaves a second line nothing repositions (a frozen
      // ghost arrow); a self-loop is a zero-length line rendering as a floating arrowhead.
      const { nodes, links } = buildGraph(['Aqsa Anwar']);
      const polluted: GraphLink[] = [
        ...links,
        { ...links[0] },
        {
          id: 'self-loop',
          relationship_id: 'self-loop',
          source: CENTER_ID,
          target: CENTER_ID,
          relationship_type: 'KNOWS',
          strength: 0.5,
          properties: {},
        },
      ];

      render(<ForceGraph nodes={nodes} links={polluted} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node')).toHaveLength(nodes.length);
      });

      expect(screen.getAllByTestId('force-link')).toHaveLength(1);
    });

    it('reports a link click through onLinkSelect', async () => {
      const { nodes, links } = buildGraph(NAMES);
      const onLinkSelect = vi.fn();

      // Links are only clickable while revealed, so the click rides on a live selection.
      render(
        <ForceGraph nodes={nodes} links={links} selectedNodeId={CENTER_ID} onLinkSelect={onLinkSelect} />,
      );

      await waitFor(() => {
        expect(screen.getAllByTestId('force-link').length).toBeGreaterThan(0);
      });

      fireEvent.click(screen.getAllByTestId('force-link')[0]);

      expect(onLinkSelect).toHaveBeenCalledTimes(1);
      expect(onLinkSelect).toHaveBeenCalledWith(expect.stringMatching(/^link-/));
    });

    it('rests every link hidden until a node asks for its threads', async () => {
      const { nodes, links } = buildGraph(NAMES);

      const { rerender } = render(<ForceGraph nodes={nodes} links={links} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('force-link').length).toBeGreaterThan(0);
      });

      // At rest the picture is dots only: every thread is hidden and unclickable.
      for (const group of screen.getAllByTestId('force-link')) {
        expect(group).toHaveAttribute('data-hidden', 'true');
      }

      // Selecting a node reveals exactly the threads that describe it.
      rerender(<ForceGraph nodes={nodes} links={links} selectedNodeId="person-0" />);

      const revealed = screen
        .getAllByTestId('force-link')
        .filter((group) => group.getAttribute('data-hidden') !== 'true');

      // person-0 has exactly one link (to the centre).
      expect(revealed).toHaveLength(1);
    });

    it('names the selected node with its neighbour count', async () => {
      const { nodes, links } = buildGraph(NAMES);

      render(<ForceGraph nodes={nodes} links={links} selectedNodeId={CENTER_ID} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node').length).toBeGreaterThan(0);
      });

      // The centre is linked to all 15 leaves.
      expect(screen.getByTestId('force-node-degree')).toHaveTextContent('15 connections');
    });

    it('dims the nodes unrelated to the selected one', async () => {
      const { nodes, links } = buildGraph(NAMES);

      render(<ForceGraph nodes={nodes} links={links} selectedNodeId="person-0" />);

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node').length).toBeGreaterThan(0);
      });

      // person-0's only neighbour is the centre; a sibling leaf recedes.
      expect(nodeOpacity('Abdul Ameer')).toBe('1');
      expect(nodeOpacity('Fiona Sewell')).toBe('0.35');
    });

    it('emphasises the selected thread and recedes everything else', async () => {
      const { nodes, links } = buildGraph(NAMES);

      // link-0 joins the centre to person-0 ("Aqsa Anwar"); everyone else is off the thread.
      render(<ForceGraph nodes={nodes} links={links} selectedLinkId="link-0" />);

      await waitFor(() => {
        expect(screen.getAllByTestId('force-link').length).toBeGreaterThan(0);
      });

      const selected = screen
        .getAllByTestId('force-link')
        .filter((group) => group.getAttribute('data-selected') === 'true');

      expect(selected).toHaveLength(1);

      // The thread's endpoints stay lit; a node off the thread fades back.
      expect(nodeOpacity('Abdul Ameer')).toBe('1');
      expect(nodeOpacity('Aqsa Anwar')).toBe('1');
      expect(nodeOpacity('Fiona Sewell')).toBe('0.35');
    });

    it('treats a still click on empty canvas as a reset', async () => {
      const { nodes, links } = buildGraph(NAMES);
      const onBackgroundClick = vi.fn();

      render(<ForceGraph nodes={nodes} links={links} onBackgroundClick={onBackgroundClick} />);

      const svg = screen.getByRole('img', { name: 'Knowledge graph overview' });
      fireEvent.click(svg);

      expect(onBackgroundClick).toHaveBeenCalledTimes(1);
    });

    it('drags a node to a new position and does not treat the drop as a click', async () => {
      const { nodes, links } = buildGraph(NAMES);
      const onNodeSelect = vi.fn();

      render(<ForceGraph nodes={nodes} links={links} onNodeSelect={onNodeSelect} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node').length).toBeGreaterThan(0);
      });

      const group = screen.getAllByTestId('force-node')[0];
      const xOf = () =>
        Number.parseFloat(/translate\(([-\d.]+),/.exec(group.getAttribute('transform') ?? '')?.[1] ?? '0');

      fireEvent.pointerDown(group, { button: 0, clientX: 100, clientY: 100 });
      const grabbedAt = xOf();
      fireEvent.pointerMove(group, { clientX: 400, clientY: 100 });
      fireEvent.pointerUp(group);

      // The drag pins the node to the pointer (fx/fy) and reheats the simulation, so the node
      // converges rightward onto the pin rather than staying where the layout had it.
      await waitFor(() => {
        expect(xOf()).toBeGreaterThan(grabbedAt + 10);
      });

      // The click browsers fire after a drag's pointer-up must not open the entity dialog.
      fireEvent.click(group);
      expect(onNodeSelect).not.toHaveBeenCalled();
    });

    it('does not treat a node click as a background click', async () => {
      const { nodes, links } = buildGraph(NAMES);
      const onBackgroundClick = vi.fn();
      const onNodeSelect = vi.fn();

      render(
        <ForceGraph
          nodes={nodes}
          links={links}
          onNodeSelect={onNodeSelect}
          onBackgroundClick={onBackgroundClick}
        />,
      );

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node').length).toBeGreaterThan(0);
      });

      fireEvent.click(screen.getAllByTestId('force-node')[0]);

      expect(onNodeSelect).toHaveBeenCalledTimes(1);
      expect(onBackgroundClick).not.toHaveBeenCalled();
    });
  });

  describe('expanded past the focused node', () => {
    /** The reported shape: the subject touches one hub, and the hub touches everybody else. */
    function buildTwoHopGraph(names: string[]): { nodes: GraphNode[]; links: GraphLink[] } {
      const person = (id: string, name: string): GraphNode => ({
        id,
        entity_id: id,
        entity_type: 'PersonType',
        name,
        description: null,
        properties: {},
      });
      const link = (id: string, source: string, target: string): GraphLink => ({
        id,
        relationship_id: id,
        source,
        target,
        relationship_type: 'KNOWS',
        strength: 0.5,
        properties: {},
      });

      return {
        nodes: [
          person(CENTER_ID, 'Abdul Ameer'),
          person(HUB_ID, 'Hanzla Mateen'),
          ...names.map((name, index) => person(`person-${index}`, name)),
        ],
        links: [
          link('link-hub', CENTER_ID, HUB_ID),
          ...names.map((_, index) => link(`link-${index}`, HUB_ID, `person-${index}`)),
        ],
      };
    }

    const contextGroups = () =>
      screen.getAllByTestId('force-node').filter((group) => group.getAttribute('data-context') === 'true');

    it('names the focused node and its own connections, and nobody else', async () => {
      const { nodes, links } = buildTwoHopGraph(NAMES);

      render(
        <ForceGraph
          nodes={nodes}
          links={links}
          centerNodeId={CENTER_ID}
          selectedNodeId={CENTER_ID}
          focusHops={1}
        />,
      );

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node')).toHaveLength(nodes.length);
      });

      const named = screen
        .getAllByTestId('force-node')
        .map((group) => group.querySelector('text')?.textContent ?? '')
        .filter((label) => label !== '');

      // 15 of these 17 people are on the page because Hanzla knows them, not because Abdul does.
      // Drawing all 17 names is what made a page about one person read as a page about another.
      expect(named.sort()).toEqual(['Abdul Ameer', 'Hanzla Mateen']);
      expect(contextGroups()).toHaveLength(NAMES.length);
    });

    it('fades the context ring rather than dropping it', async () => {
      const { nodes, links } = buildTwoHopGraph(NAMES);

      render(<ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} focusHops={1} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node')).toHaveLength(nodes.length);
      });

      // Still on screen and still countable — the wider neighbourhood is worth showing, just not
      // worth drawing as though the page were about it.
      for (const group of contextGroups()) {
        expect(Number.parseFloat(group.getAttribute('opacity') ?? '1')).toBeLessThan(1);
      }
    });

    it('draws a context node smaller than the same node would be up close', async () => {
      const { nodes, links } = buildTwoHopGraph(NAMES);
      const radiusOf = (label: string) => {
        const group = screen
          .getAllByTestId('force-node')
          .find((candidate) => candidate.querySelector('title')?.textContent?.startsWith(label));

        return Number.parseFloat(group?.querySelector('circle')?.getAttribute('r') ?? '0');
      };

      const { rerender } = render(
        <ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} focusHops={1} />,
      );

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node')).toHaveLength(nodes.length);
      });

      const asContext = radiusOf('Aqsa Anwar');

      rerender(<ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} />);

      await waitFor(() => {
        expect(radiusOf('Aqsa Anwar')).toBeGreaterThan(asContext);
      });
    });

    it('brings a context node back to full weight under the pointer', async () => {
      const { nodes, links } = buildTwoHopGraph(NAMES);

      render(<ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} focusHops={1} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node')).toHaveLength(nodes.length);
      });

      const distant = contextGroups()[0];
      fireEvent.pointerEnter(distant);

      await waitFor(() => {
        // Receding is not the same as being unreachable: pointing at the ring still explores it.
        expect(distant).toHaveAttribute('opacity', '1');
        expect(distant.querySelector('text')?.textContent ?? '').not.toBe('');
      });
    });

    it('weights every node equally when no focus was asked for', async () => {
      // The graph explorer is a browser, not a page about one entity; it centres on whatever the
      // viewer last clicked and must not fade the rest of the graph out from under them.
      const { nodes, links } = buildTwoHopGraph(NAMES);

      render(<ForceGraph nodes={nodes} links={links} centerNodeId={CENTER_ID} />);

      await waitFor(() => {
        expect(screen.getAllByTestId('force-node')).toHaveLength(nodes.length);
      });

      expect(contextGroups()).toHaveLength(0);

      const named = screen
        .getAllByTestId('force-node')
        .map((group) => group.querySelector('text')?.textContent ?? '')
        .filter((label) => label !== '');

      expect(named).toHaveLength(nodes.length);
    });
  });
});
