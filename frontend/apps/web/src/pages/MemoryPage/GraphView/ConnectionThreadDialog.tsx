import { Badge, Button, cn } from '@ci/shadcn';
import { MoveRight, X } from '@ci/shadcn/icons';

import type { GraphLink, GraphNode } from '@/api/useGraphOverview';
import { colorForRawType } from '@/components/entities/entityVisuals';
import { formatEnumLabel } from '@/lib/utils';

import { useThrowableCard } from './useThrowableCard';

interface ConnectionThreadDialogProps {
  link: GraphLink;
  sourceNode: GraphNode | null;
  targetNode: GraphNode | null;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
}

const MAX_PROPERTIES = 6;

function EndpointButton({
  node,
  fallback,
  onSelect,
}: {
  node: GraphNode | null;
  fallback: string;
  onSelect: (nodeId: string) => void;
}) {
  if (!node) {
    return <span className="truncate text-muted-foreground">{fallback}</span>;
  }

  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-1.5 text-left hover:underline"
      onClick={() => onSelect(node.id)}
    >
      <span
        className="h-2 w-2 flex-shrink-0 rounded-full"
        style={{ backgroundColor: colorForRawType(node.entity_type) }}
        aria-hidden
      />
      <span className="truncate font-medium">{node.name ?? node.entity_type}</span>
    </button>
  );
}

/**
 * Connection-thread dialog: the relationship the viewer picked out of the graph, with its type,
 * direction, strength and metadata. Clicking either endpoint hands selection to that entity.
 */
export function ConnectionThreadDialog({
  link,
  sourceNode,
  targetNode,
  onSelectNode,
  onClose,
}: ConnectionThreadDialogProps) {
  const strength = Math.max(0, Math.min(1, link.strength));
  const properties = Object.entries(link.properties ?? {}).slice(0, MAX_PROPERTIES);
  const { cardRef, handleProps } = useThrowableCard();

  return (
    <div
      ref={cardRef}
      data-testid="connection-thread-dialog"
      role="dialog"
      aria-label={`Connection: ${formatEnumLabel(link.relationship_type)}`}
      className="absolute right-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-80 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border bg-background/95 shadow-xl backdrop-blur will-change-transform"
    >
      <div {...handleProps} className={cn('flex items-start gap-2 border-b p-3', handleProps.className)}>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">Connection</p>
          <Badge variant="secondary" className="mt-1">
            {formatEnumLabel(link.relationship_type)}
          </Badge>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 flex-shrink-0"
          onClick={onClose}
          aria-label="Close connection dialog"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <EndpointButton node={sourceNode} fallback={link.source} onSelect={onSelectNode} />
          <MoveRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-label="to" />
          <EndpointButton node={targetNode} fallback={link.target} onSelect={onSelectNode} />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Strength</span>
            <span className="font-medium tabular-nums">{Math.round(strength * 100)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${strength * 100}%` }} />
          </div>
        </div>

        {properties.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Metadata</p>
            <ul className="space-y-1">
              {properties.map(([key, value]) => (
                <li key={key} className="flex min-w-0 gap-2 text-xs">
                  <span className="min-w-[80px] flex-shrink-0 text-muted-foreground">{key}</span>
                  <span className="min-w-0 truncate">{String(value)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
