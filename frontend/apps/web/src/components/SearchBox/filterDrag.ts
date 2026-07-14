// Drag payload for dragging a search result (person, place, tag) onto the
// Memory explorer's filter drop area. The kind + name travel as JSON under a
// custom type; a text/plain copy is set alongside it so dragging elsewhere
// degrades to plain text instead of nothing.
export const FILTER_DRAG_TYPE = 'application/x-ci-filter-entity';

export type FilterDragKind = 'person' | 'place' | 'tag';

export interface FilterDragPayload {
  kind: FilterDragKind;
  name: string;
}

export function isFilterDrag(event: React.DragEvent): boolean {
  return event.dataTransfer.types.includes(FILTER_DRAG_TYPE);
}

export function startFilterDrag(event: React.DragEvent, kind: FilterDragKind, name: string) {
  event.dataTransfer.setData(FILTER_DRAG_TYPE, JSON.stringify({ kind, name }));
  event.dataTransfer.setData('text/plain', name);
  event.dataTransfer.effectAllowed = 'copy';
}

export function readFilterDrag(event: React.DragEvent): FilterDragPayload | null {
  const raw = event.dataTransfer.getData(FILTER_DRAG_TYPE);

  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'kind' in parsed &&
      (parsed.kind === 'person' || parsed.kind === 'place' || parsed.kind === 'tag') &&
      'name' in parsed &&
      typeof parsed.name === 'string'
    ) {
      return { kind: parsed.kind, name: parsed.name };
    }
  } catch {
    // Fall through: a malformed payload is treated as not-a-filter-drag.
  }

  return null;
}
