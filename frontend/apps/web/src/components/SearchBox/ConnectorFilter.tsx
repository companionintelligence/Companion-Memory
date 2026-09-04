import { useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';
import { Button, DropdownMenu } from '@ci/shadcn';
import { ChevronDown, Database } from '@ci/shadcn/icons';
import { useLocation, useSearchParams } from 'react-router-dom';

import { gql } from '@/graphql';
import { explorerSearchTypeFilters } from '@/pages/MemoryPage/Components/ExplorerToolbar/filterParams';

// "Source" — the data-source dimension (gmail, imessage, reddit, ...).
// Populated from the distinct `source_system` values across every kind the
// explorer browses — events, messages, content, browser activity, receipts,
// products and things — not just events, since the search applies the
// selection to all of them (see SearchResolver SOURCED_TYPES).
export const SOURCE_SYSTEMS_QUERY = gql(`
  query SourceSystems($includeTypes: [String!], $excludeTypes: [String!]) {
    sourceSystems(includeTypes: $includeTypes, excludeTypes: $excludeTypes)
  }
`);

function toIndexableTypes(displayTypes: string[]): string[] {
  return displayTypes.map(
    (type) => ENTITY_TYPE_MAP[type as keyof typeof ENTITY_TYPE_MAP] ?? type.toLowerCase(),
  );
}

/**
 * The type filters the search itself will send, so the How list is pared to
 * the kinds actually in play: with the What bar on Content, only content's
 * sources are offered, and a kind that records no source offers none. Same
 * resolution the list and heatmap use (explorerSearchTypeFilters), including
 * the When override, so every option shown can match something.
 */
export function sourceSystemsVariables(
  params: URLSearchParams,
  pathname?: string,
): {
  includeTypes?: string[];
  excludeTypes?: string[];
} {
  const { includeTypes, excludeTypes } = explorerSearchTypeFilters(params, pathname);

  return {
    ...(includeTypes ? { includeTypes: toIndexableTypes(includeTypes) } : {}),
    ...(excludeTypes ? { excludeTypes: toIndexableTypes(excludeTypes) } : {}),
  };
}

interface Props {
  modal?: boolean;
  /** When set, renders a plain "{label}: {value}" trigger (e.g. "How: all"). */
  label?: string;
  /**
   * The kinds to list sources for, in the search index's names, when the page
   * is not the explorer and its What filters do not apply — the content
   * library passes `['content']`. Without it the list follows the URL's What
   * selection, as the explorer's does.
   */
  includeTypes?: string[];
}

export function ConnectorFilter({ modal = true, label, includeTypes }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();

  const variables = useMemo(
    () => (includeTypes ? { includeTypes } : sourceSystemsVariables(searchParams, pathname)),
    [includeTypes, searchParams, pathname],
  );
  const { data } = useQuery(SOURCE_SYSTEMS_QUERY, { variables });
  const availableSources = data?.sourceSystems ?? [];

  const selectedSources = searchParams.get('connectors')?.split(',').filter(Boolean) ?? [];

  const { CheckboxItem, Content, Label, Separator, Trigger } = DropdownMenu;

  const selectedCount = selectedSources.length;

  const getDisplayText = () => {
    if (label) {
      const value =
        selectedCount === 0 ? 'all' : selectedCount === 1 ? selectedSources[0] : `${selectedCount} selected`;

      return `${label}: ${value}`;
    }

    if (selectedCount === 0) {
      return 'All Sources';
    }

    if (selectedCount === 1) {
      return selectedSources[0];
    }

    return `${selectedCount} Sources`;
  };

  const setConnectors = (next: string[]) => {
    setSearchParams((params) => {
      if (next.length === 0) {
        params.delete('connectors');
      } else {
        params.set('connectors', next.join(','));
      }

      return params;
    });
  };

  const toggleConnector = (source: string) => {
    if (selectedSources.includes(source)) {
      setConnectors(selectedSources.filter((value) => value !== source));
    } else {
      setConnectors([...selectedSources, source]);
    }
  };

  return (
    <DropdownMenu modal={modal} open={isOpen} onOpenChange={setIsOpen}>
      <Trigger asChild>
        <Button type="button" variant="outline">
          {label && <Database className="mr-2 h-4 w-4 text-muted-foreground" />}
          {getDisplayText()}
          <ChevronDown
            className={`ml-2 h-4 w-4 opacity-50 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </Button>
      </Trigger>

      <Content
        id="connector-filters"
        align="start"
        sideOffset={4}
        className="z-[9999] max-h-80 w-64 overflow-y-auto rounded-md border border-border bg-background p-1 shadow-lg"
      >
        <div className="flex items-center justify-between gap-3 px-2 py-1.5">
          <Label className="text-sm font-medium">Source</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConnectors([])}
            className="h-7 px-2 text-xs text-muted-foreground"
          >
            Clear
          </Button>
        </div>
        <Separator />
        {availableSources.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground">No sources yet</div>
        ) : (
          availableSources.map((source) => {
            const isChecked = selectedSources.includes(source);

            return (
              <CheckboxItem
                key={source}
                checked={isChecked}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  toggleConnector(source);
                }}
              >
                {source}
              </CheckboxItem>
            );
          })
        )}
      </Content>
    </DropdownMenu>
  );
}
