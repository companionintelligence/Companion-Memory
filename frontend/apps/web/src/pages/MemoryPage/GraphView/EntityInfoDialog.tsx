import { Badge, Button, cn } from '@ci/shadcn';
import { Crosshair, PanelRight, X } from '@ci/shadcn/icons';

import type { GraphLink, GraphNode } from '@/api/useGraphOverview';
import { colorForRawType } from '@/components/entities/entityVisuals';
import { formatEnumLabel } from '@/lib/utils';

import { useThrowableCard } from './useThrowableCard';

/** One row of the dialog's connection list: the relationship and whoever is on the other end. */
export interface EntityRelation {
  link: GraphLink;
  otherNode: GraphNode | null;
  direction: 'outbound' | 'inbound';
}

interface EntityInfoDialogProps {
  node: GraphNode;
  relations: EntityRelation[];
  /** Whether the view is already focused on this entity's subgraph. */
  isFocused: boolean;
  onFocus: () => void;
  onOpenDetails: () => void;
  onSelectNode: (nodeId: string) => void;
  onSelectLink: (linkId: string) => void;
  onClose: () => void;
}

const MAX_PROPERTIES = 6;
const MAX_RELATIONS = 10;

/**
 * Webbed Feet-style floating info card: it overlays the canvas rather than blocking it, so the
 * graph stays explorable while the card is open and clicking through connections walks the graph.
 */
export function EntityInfoDialog({
  node,
  relations,
  isFocused,
  onFocus,
  onOpenDetails,
  onSelectNode,
  onSelectLink,
  onClose,
}: EntityInfoDialogProps) {
  const typeColor = colorForRawType(node.entity_type);
  const properties = Object.entries(node.properties ?? {}).slice(0, MAX_PROPERTIES);
  const { cardRef, handleProps } = useThrowableCard();

  return (
    <div
      ref={cardRef}
      data-testid="entity-info-dialog"
      role="dialog"
      aria-label={`Entity: ${node.name ?? node.entity_type}`}
      className="absolute right-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-80 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-xl border bg-background/95 shadow-xl backdrop-blur will-change-transform"
    >
      <div {...handleProps} className={cn('flex items-start gap-2 border-b p-3', handleProps.className)}>
        <span
          className="mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: typeColor }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{node.name ?? 'Untitled Entity'}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            <Badge variant="outline" style={{ borderColor: typeColor }}>
              {formatEnumLabel(node.entity_type)}
            </Badge>
            {/* Event kind (visited / messaged / traveled / …) — the What dimension. */}
            {node.event_type && <Badge variant="secondary">{formatEnumLabel(node.event_type)}</Badge>}
          </div>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 flex-shrink-0"
          onClick={onClose}
          aria-label="Close entity dialog"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {node.description && <p className="break-words text-muted-foreground">{node.description}</p>}

        {properties.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Properties</p>
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

        {relations.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Connections</p>
            <ul className="space-y-1">
              {relations.slice(0, MAX_RELATIONS).map(({ link, otherNode }) => (
                <li key={link.id} className="flex min-w-0 items-center justify-between gap-2 text-xs">
                  <button
                    type="button"
                    className="min-w-0 truncate text-left hover:underline"
                    onClick={() => otherNode && onSelectNode(otherNode.id)}
                    disabled={!otherNode}
                  >
                    {otherNode?.name ?? otherNode?.entity_type ?? 'Unknown'}
                  </button>
                  <button
                    type="button"
                    className="flex-shrink-0"
                    onClick={() => onSelectLink(link.id)}
                    aria-label={`View connection: ${formatEnumLabel(link.relationship_type)}`}
                  >
                    <Badge variant="secondary" className="cursor-pointer hover:bg-secondary/70">
                      {formatEnumLabel(link.relationship_type)}
                    </Badge>
                  </button>
                </li>
              ))}
            </ul>
            {relations.length > MAX_RELATIONS && (
              <p className="text-[11px] text-muted-foreground">
                +{relations.length - MAX_RELATIONS} more — focus to explore the full neighbourhood.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex gap-2 border-t p-3">
        <Button
          type="button"
          size="sm"
          variant={isFocused ? 'secondary' : 'default'}
          className="flex-1"
          onClick={onFocus}
          disabled={isFocused}
        >
          <Crosshair className="mr-1.5 h-3.5 w-3.5" />
          {isFocused ? 'Focused' : 'Focus'}
        </Button>
        <Button type="button" size="sm" variant="outline" className="flex-1" onClick={onOpenDetails}>
          <PanelRight className="mr-1.5 h-3.5 w-3.5" />
          Details
        </Button>
      </div>
    </div>
  );
}
