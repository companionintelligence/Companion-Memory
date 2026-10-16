import { useState } from 'react';

import { MapPin, Users } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import {
  AREAS_PARAM,
  LEGACY_BBOX_PARAM,
  formatAreas,
  mapAreasLabel,
  readAreasParam,
} from '@/pages/MemoryPage/bbox';
import {
  ENTITY_FILTER_KINDS,
  addEntityFilter,
  readListParam,
  removeEntityFilter,
  writeListParam,
} from '@/pages/MemoryPage/Components/ExplorerToolbar/filterParams';

import { DirectionToggle, readMessageDirection } from './DirectionToggle';
import { FilterValuePicker, type FilterValuePickerProps } from './FilterValuePicker';
import { MapAreaList } from './MapAreaList';
import { usePersonNameSuggestions, usePlaceNameSuggestions } from './useNameSuggestions';

// "Who" / "Where" — the explorer's person and place name dimensions
// (`?people=` / `?places=`), the same params a drag from the header search
// results onto the filter drop area writes. Where narrows the result to
// events at a matching place OR inside one of the map's rectangles
// (`?areas=`, drawn on the map, listed and removable here); Who to events and
// communications involving a matching person (SearchInput.people / .places).
// The toolbar offers each only while a kind it can act on is in play
// (eventsInPlay / peopleInPlay).
const KINDS = {
  person: {
    label: 'Who',
    icon: Users,
    useSuggestions: usePersonNameSuggestions,
    searchPlaceholder: 'Search people…',
    emptyText: 'No people match',
    hint: 'You can also drag a person from the search results onto the filters.',
  },
  place: {
    label: 'Where',
    icon: MapPin,
    useSuggestions: usePlaceNameSuggestions,
    searchPlaceholder: 'Search places…',
    emptyText: 'No places match',
    hint: 'You can also drag a place from the search results onto the filters.',
  },
} as const;

interface Props {
  kind: keyof typeof KINDS;
  modal?: boolean;
  /** Opens the picker from the caller's own element (the phone filter sheet's row). */
  renderTrigger?: FilterValuePickerProps['renderTrigger'];
}

export function EntityNameFilter({ kind, modal = true, renderTrigger }: Props) {
  const { label, icon, useSuggestions, searchPlaceholder, emptyText, hint } = KINDS[kind];
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const { names, loading, hasMore, loadingMore, loadMore } = useSuggestions(query, open);
  const { param } = ENTITY_FILTER_KINDS[kind];
  const values = readListParam(searchParams, param);
  // Who carries the From / To toggle (`?direction=`), since the
  // direction of a message is a fact about the person on the other end.
  const direction = kind === 'person' ? readMessageDirection(searchParams.get('direction')) : null;
  // Where also carries the map's rectangles: the trigger counts them beside
  // the names, the panel lists them, and Clear takes both.
  const areas = kind === 'place' ? (readAreasParam(searchParams) ?? []) : [];

  const writeAreas = (params: URLSearchParams, next: typeof areas) => {
    if (next.length > 0) {
      params.set(AREAS_PARAM, formatAreas(next));
    } else {
      params.delete(AREAS_PARAM);
    }

    // The list supersedes whatever single box an old link carried.
    params.delete(LEGACY_BBOX_PARAM);
  };

  const add = (value: string): string | null => {
    let problem: string | null = null;

    setSearchParams((params) => {
      problem = addEntityFilter(params, kind, value);

      return params;
    });

    return problem;
  };

  return (
    <FilterValuePicker
      variant="toolbar"
      label={label}
      extraSummary={areas.length > 0 ? mapAreasLabel(areas.length) : undefined}
      countValues={kind === 'place'}
      icon={icon}
      modal={modal}
      values={values}
      options={names}
      loading={loading}
      hasMore={hasMore}
      loadingMore={loadingMore}
      onLoadMore={loadMore}
      onSearch={setQuery}
      onOpenChange={setOpen}
      onAdd={add}
      onRemove={(value) =>
        setSearchParams((params) => {
          removeEntityFilter(params, kind, value);

          return params;
        })
      }
      onClear={() =>
        setSearchParams((params) => {
          writeListParam(params, param, []);

          if (kind === 'place') {
            writeAreas(params, []);
          }

          return params;
        })
      }
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      footer={
        kind === 'person' ? (
          <DirectionToggle
            value={direction}
            onChange={(next) =>
              setSearchParams((params) => {
                if (next) {
                  params.set('direction', next);
                } else {
                  params.delete('direction');
                }

                return params;
              })
            }
          />
        ) : kind === 'place' ? (
          <MapAreaList
            areas={areas}
            onRemove={(index) =>
              setSearchParams((params) => {
                writeAreas(
                  params,
                  areas.filter((_, position) => position !== index),
                );

                return params;
              })
            }
          />
        ) : undefined
      }
      hint={hint}
      renderTrigger={renderTrigger}
    />
  );
}
