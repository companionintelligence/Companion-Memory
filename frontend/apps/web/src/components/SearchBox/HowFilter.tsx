import { useState } from 'react';

import { useQuery } from '@apollo/client';
import { Button, DropdownMenu } from '@ci/shadcn';
import { ChevronDown } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { gql } from '@/graphql';

// "How things happened" — the activity/event-type dimension (visited, messaged,
// called, ate, traveled, purchased, ...). Populated from the distinct event
// types present for the user.
const EVENT_TYPES_QUERY = gql(`
  query EventTypes {
    eventTypes
  }
`);

interface Props {
  modal?: boolean;
}

export function HowFilter({ modal = true }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const { data } = useQuery(EVENT_TYPES_QUERY);
  const availableEventTypes = data?.eventTypes ?? [];

  const selectedEventTypes = searchParams.get('eventTypes')?.split(',').filter(Boolean) ?? [];

  const { CheckboxItem, Content, Label, Separator, Trigger } = DropdownMenu;

  const selectedCount = selectedEventTypes.length;

  const getDisplayText = () => {
    if (selectedCount === 0) {
      return 'All Activities';
    }

    if (selectedCount === 1) {
      return selectedEventTypes[0];
    }

    return `${selectedCount} Activities`;
  };

  const setEventTypes = (next: string[]) => {
    setSearchParams((params) => {
      if (next.length === 0) {
        params.delete('eventTypes');
      } else {
        params.set('eventTypes', next.join(','));
      }

      return params;
    });
  };

  const toggleEventType = (eventType: string) => {
    if (selectedEventTypes.includes(eventType)) {
      setEventTypes(selectedEventTypes.filter((type) => type !== eventType));
    } else {
      setEventTypes([...selectedEventTypes, eventType]);
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
        id="how-filters"
        className="fixed bg-background border border-border rounded-md shadow-lg z-[9999] max-h-80 overflow-y-auto w-64"
      >
        <div className="flex gap-2">
          <Label className="p-2 font-medium">How (Activity)</Label>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => setEventTypes([])}
              className="text-xs px-4 py-1 bg-background text-primary hover:text-background"
            >
              Clear
            </Button>
          </div>
        </div>
        <Separator />
        {availableEventTypes.length === 0 ? (
          <div className="p-2 text-xs text-muted-foreground">No activity types yet</div>
        ) : (
          availableEventTypes.map((eventType) => {
            const isChecked = selectedEventTypes.includes(eventType);

            return (
              <CheckboxItem
                key={eventType}
                checked={isChecked}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  toggleEventType(eventType);
                }}
              >
                {eventType}
              </CheckboxItem>
            );
          })
        )}
      </Content>
    </DropdownMenu>
  );
}
