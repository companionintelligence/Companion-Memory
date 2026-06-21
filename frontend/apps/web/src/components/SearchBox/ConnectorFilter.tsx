import { useState } from 'react';

import { useQuery } from '@apollo/client';
import { Button, DropdownMenu } from '@ci/shadcn';
import { ChevronDown } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { gql } from '@/graphql';

// "Connector" — the data-source dimension (gmail, imessage, spotify, ...).
// Populated from the distinct event sources present for the user.
const EVENT_SOURCES_QUERY = gql(`
  query EventSources {
    eventSources
  }
`);

interface Props {
  modal?: boolean;
}

export function ConnectorFilter({ modal = true }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const { data } = useQuery(EVENT_SOURCES_QUERY);
  const availableSources = data?.eventSources ?? [];

  const selectedSources = searchParams.get('connectors')?.split(',').filter(Boolean) ?? [];

  const { CheckboxItem, Content, Label, Separator, Trigger } = DropdownMenu;

  const selectedCount = selectedSources.length;

  const getDisplayText = () => {
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
      <Trigger>
        <Button type="button" variant="outline">
          {getDisplayText()}
          <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </Button>
      </Trigger>

      <Content
        id="connector-filters"
        className="fixed bg-background border border-border rounded-md shadow-lg z-[9999] max-h-80 overflow-y-auto w-64"
      >
        <div className="flex gap-2">
          <Label className="p-2 font-medium">Connector (Source)</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => setConnectors([])}
              className="text-xs px-4 py-1 bg-background text-primary hover:text-background"
            >
              Clear
            </Button>
          </div>
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
