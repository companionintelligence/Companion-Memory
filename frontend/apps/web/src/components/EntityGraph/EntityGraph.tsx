import { type ReactNode } from 'react';

import { EmptyState, LoadingPage } from '@ci/common';
import { Card } from '@ci/shadcn';
import { Share2 } from '@ci/shadcn/icons';

import { useNodeGraphService } from '@/api/useNodeGraphService';
import { ForceGraph } from '@/components/ForceGraph';

interface Props {
  entityId: string;
  maxDepth?: number;
  nodeLimit?: number;
}

export function EntityGraph({ entityId, maxDepth = 1, nodeLimit = 25 }: Props) {
  const { data, loading } = useNodeGraphService({
    entityId,
    maxDepth,
    nodeLimit,
    skip: !entityId,
  });

  let content: ReactNode | null;

  if (loading) {
    content = <LoadingPage />;
  } else if (data == null) {
    content = (
      <EmptyState
        icon={<Share2 size={48} className="text-[rgb(6,108,128)]" />}
        message="No connection data available"
      />
    );
  } else {
    content = (
      <ForceGraph
        nodes={data?.nodes ?? []}
        links={data?.links ?? []}
        highlightedNodeId={entityId}
        centerNodeId={entityId}
        selectedNodeId={entityId}
        // This panel is on a page ABOUT one entity, so its own connections are the subject and
        // anything beyond them is background. Raising `maxDepth` past 1 pulls in a neighbour's whole
        // neighbourhood, which on a sparsely connected entity is most of the picture.
        focusHops={1}
      />
    );
  }

  return (
    <Card className="p-0 flex-1 relative min-h-[420px]">
      <Card.Content className="p-0">{content}</Card.Content>
    </Card>
  );
}
