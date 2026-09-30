import { useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';
import { Database } from '@ci/shadcn/icons';
import { useLocation, useSearchParams } from 'react-router-dom';

import { gql } from '@/graphql';
import {
  explorerSearchTypeFilters,
  readCsvParam,
  validateExactFilterValue,
  writeCsvFilterParam,
} from '@/pages/MemoryPage/Components/ExplorerToolbar/filterParams';

import { FilterValuePicker, type FilterValuePickerProps } from './FilterValuePicker';

// "How" — the data-source dimension (gmail, imessage, reddit, ...), written
// to `?connectors=`. Populated from the distinct `source_system` values across
// every kind the explorer browses — events, messages, content, browser
// activity, receipts, products and things — not just events, since the search
// applies the selection to all of them (see SearchResolver SOURCED_TYPES).
// The backend matches the selection exactly, so the picker is confined to
// that list: no free text, and a URL-carried name the list no longer holds
// is flagged rather than silently matching nothing.
export const SOURCE_SYSTEMS_QUERY = gql(`
  query SourceSystems($includeTypes: [String!], $excludeTypes: [String!]) {
    sourceSystems(includeTypes: $includeTypes, excludeTypes: $excludeTypes)
  }
`);

export const CONNECTORS_PARAM = 'connectors';

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
  /** Dimension name on the trigger ("How: all"). */
  label?: string;
  /**
   * The kinds to list sources for, in the search index's names, when the page
   * is not the explorer and its What filters do not apply — the content
   * library passes `['content']`. Without it the list follows the URL's What
   * selection, as the explorer's does.
   */
  includeTypes?: string[];
  /** Opens the picker from the caller's own element (the phone filter sheet's row). */
  renderTrigger?: FilterValuePickerProps['renderTrigger'];
}

export function ConnectorFilter({ modal = true, label = 'How', includeTypes, renderTrigger }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);

  const variables = useMemo(
    () => (includeTypes ? { includeTypes } : sourceSystemsVariables(searchParams, pathname)),
    [includeTypes, searchParams, pathname],
  );
  // Fetched only once the picker has been opened, like the name pickers, so a
  // page that mounts several pickers pays for none until one is used.
  const { data, loading } = useQuery(SOURCE_SYSTEMS_QUERY, { variables, skip: !open });

  const values = readCsvParam(searchParams, CONNECTORS_PARAM);

  const write = (next: string[]) =>
    setSearchParams((params) => {
      writeCsvFilterParam(params, CONNECTORS_PARAM, next);

      return params;
    });

  return (
    <FilterValuePicker
      variant="toolbar"
      label={label}
      icon={Database}
      modal={modal}
      values={values}
      options={data?.sourceSystems ?? []}
      optionsKnown={data != null}
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
      searchPlaceholder="Search sources…"
      emptyText="No sources match"
      unknownValueHint="No connected source has this name, so this filter matches nothing."
      renderTrigger={renderTrigger}
    />
  );
}
