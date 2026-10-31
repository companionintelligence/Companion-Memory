import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useNodeGraphService: vi.fn() }));

vi.mock('@/api/useNodeGraphService', () => ({
  useNodeGraphService: mocks.useNodeGraphService,
}));

vi.mock('@ci/common', () => ({
  EmptyState: ({ message }: { message: string }) => <div role="status">{message}</div>,
  LoadingPage: () => <div role="status">Loading graph</div>,
}));

vi.mock('@ci/shadcn', () => {
  const Content = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  const Card = Object.assign(
    ({ children, className }: { children: React.ReactNode; className?: string }) => (
      <section className={className}>{children}</section>
    ),
    { Content },
  );

  return { Card };
});

vi.mock('@/components/ForceGraph', () => ({
  ForceGraph: ({
    nodes,
    links,
    highlightedNodeId,
    centerNodeId,
    selectedNodeId,
    focusHops,
  }: {
    nodes: unknown[];
    links: unknown[];
    highlightedNodeId: string;
    centerNodeId: string;
    selectedNodeId: string;
    focusHops: number;
  }) => (
    <div
      data-testid="force-graph"
      data-node-count={nodes.length}
      data-link-count={links.length}
      data-highlighted={highlightedNodeId}
      data-centered={centerNodeId}
      data-selected={selectedNodeId}
      data-focus-hops={focusHops}
    />
  ),
}));

import { EntityGraph } from './EntityGraph';

describe('EntityGraph', () => {
  beforeEach(() => mocks.useNodeGraphService.mockReset());

  it('requests a graph for the entity and shows its loading state', () => {
    mocks.useNodeGraphService.mockReturnValue({ data: undefined, loading: true });

    render(<EntityGraph entityId="person-1" />);

    expect(mocks.useNodeGraphService).toHaveBeenCalledWith({
      entityId: 'person-1',
      maxDepth: 1,
      nodeLimit: 25,
      skip: false,
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading graph');
  });

  it('shows the empty state when no connection data is available', () => {
    mocks.useNodeGraphService.mockReturnValue({ data: null, loading: false });

    render(<EntityGraph entityId="person-1" maxDepth={2} nodeLimit={40} />);

    expect(screen.getByRole('status')).toHaveTextContent('No connection data available');
    expect(mocks.useNodeGraphService).toHaveBeenCalledWith({
      entityId: 'person-1',
      maxDepth: 2,
      nodeLimit: 40,
      skip: false,
    });
  });

  it('renders the graph focused on the requested entity', () => {
    mocks.useNodeGraphService.mockReturnValue({
      data: { nodes: [{ id: 'person-1' }, { id: 'place-1' }], links: [{ source: 'person-1' }] },
      loading: false,
    });

    render(<EntityGraph entityId="person-1" />);

    expect(screen.getByTestId('force-graph')).toHaveAttribute('data-node-count', '2');
    expect(screen.getByTestId('force-graph')).toHaveAttribute('data-link-count', '1');
    expect(screen.getByTestId('force-graph')).toHaveAttribute('data-highlighted', 'person-1');
    expect(screen.getByTestId('force-graph')).toHaveAttribute('data-centered', 'person-1');
    expect(screen.getByTestId('force-graph')).toHaveAttribute('data-selected', 'person-1');
    expect(screen.getByTestId('force-graph')).toHaveAttribute('data-focus-hops', '1');
  });

  it('passes empty collections to the graph when a response omits either list', () => {
    mocks.useNodeGraphService.mockReturnValue({ data: { nodes: null, links: undefined }, loading: false });

    render(<EntityGraph entityId="person-1" />);

    expect(screen.getByTestId('force-graph')).toHaveAttribute('data-node-count', '0');
    expect(screen.getByTestId('force-graph')).toHaveAttribute('data-link-count', '0');
  });

  it('skips the graph request when no entity id was supplied', () => {
    mocks.useNodeGraphService.mockReturnValue({ data: null, loading: false });

    render(<EntityGraph entityId="" />);

    expect(mocks.useNodeGraphService).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: '', skip: true }),
    );
  });
});
