import { useState } from 'react';

import { useQuery } from '@apollo/client';
import { Activity } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import { gql } from '@/graphql';
import { filterValueLabel } from '@/lib/sourceNames';
import {
  readCsvParam,
  validateExactFilterValue,
  writeCsvFilterParam,
} from '@/pages/MemoryPage/Components/ExplorerToolbar/filterParams';

import { FilterValuePicker, type FilterValuePickerProps } from './FilterValuePicker';

// "Activity" — the event-type dimension (visited, messaged, called, ate,
// traveled, purchased, ...), written to `?eventTypes=`. Populated from the
// distinct event types present for the user, and confined to that list: the
// backend matches the selection exactly, so free text is refused and a
// URL-carried type the list no longer holds is flagged. Event-scoped: the
// search only applies it to rows of kind `event` and lets every other kind
// through, so the explorer pins the browse to events while one is set —
// unless the What bar picked another kind alongside events on purpose
// (resolveExplorerTypes) — and mounts this picker only while events are
// among the kinds in play (see eventsInPlay).
//
// Not to be confused with the toolbar's "How" picker (ConnectorFilter), which
// is the data-source dimension (`?connectors=`, matched on source_system).
export const EVENT_TYPES_QUERY = gql(`
  query EventTypes {
    eventTypes
  }
`);

export const EVENT_TYPES_PARAM = 'eventTypes';

interface Props {
  modal?: boolean;
  /** Dimension name on the trigger ("Activity: all"). */
  label?: string;
  /** Opens the picker from the caller's own element (the phone filter sheet's row). */
  renderTrigger?: FilterValuePickerProps['renderTrigger'];
}

export function ActivityFilter({ modal = true, label = 'Activity', renderTrigger }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);

  // Fetched only once the picker has been opened; see ConnectorFilter.
  const { data, loading } = useQuery(EVENT_TYPES_QUERY, { skip: !open });

  const values = readCsvParam(searchParams, EVENT_TYPES_PARAM);

  const write = (next: string[]) =>
    setSearchParams((params) => {
      writeCsvFilterParam(params, EVENT_TYPES_PARAM, next);

      return params;
    });

  return (
    <FilterValuePicker
      variant="toolbar"
      label={label}
      icon={Activity}
      modal={modal}
      values={values}
      options={data?.eventTypes ?? []}
      optionsKnown={data != null}
      formatValue={filterValueLabel}
      loading={loading}
      onOpenChange={setOpen}
      onAdd={(value) => {
        const problem = validateExactFilterValue(value);

        if (!problem) {
          write([...values, value]);
        }

        return problem;
      }}
      onRemove={(value) => write(values.filter((item) => item !== value))}
      onClear={() => write([])}
      searchPlaceholder="Search activities…"
      emptyText="No activities match"
      unknownValueHint="No event has this activity type, so this filter matches nothing."
      renderTrigger={renderTrigger}
    />
  );
}
