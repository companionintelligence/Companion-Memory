import { useState } from 'react';

import { useQuery } from '@apollo/client';
import { Button, DropdownMenu } from '@ci/shadcn';
import { ChevronDown, Database } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { gql } from '@/graphql';

// "Source" — the data-source dimension (gmail, imessage, spotify, ...).
// Populated from the distinct event sources present for the user.
const EVENT_SOURCES_QUERY = gql(`
  query EventSources {
    eventSources
  }
`);

interface Props {
  modal?: boolean;
  /** When set, renders a plain "{label}: {value}" trigger (e.g. "How: all"). */
  label?: string;
}

export function ConnectorFilter({ modal = true, label }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const { data } = useQuery(EVENT_SOURCES_QUERY);
  const availableSources = data?.eventSources ?? [];

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
    <DropdownMenu modal={modal} onOpenChange={() => setIsOpen(!isOpen)}>
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
