import { useCallback, useState } from 'react';

import { createHookContext } from '@ci/common';

export interface TimelineGridRange {
  /** Inclusive, `yyyy-MM-dd`. */
  start: string;
  /** Inclusive, `yyyy-MM-dd`. */
  end: string;
}

type ReturnValue = [
  { selection: TimelineGridRange | null },
  {
    setSelection: (range: TimelineGridRange | null) => void;
    clearSelection: () => void;
  },
];

/**
 * Owns the grid's selected day range. The grid writes to it on drag; anything
 * else under the provider can read the range or imperatively clear/replace it.
 */
function useTimelineGridSelection(): ReturnValue {
  const [selection, setSelection] = useState<TimelineGridRange | null>(null);

  const clearSelection = useCallback(() => setSelection(null), []);

  return [{ selection }, { setSelection, clearSelection }];
}

const { Provider, useHookContext } = createHookContext(useTimelineGridSelection, 'useTimelineGridSelection');

export { Provider as TimelineGridSelectionProvider, useHookContext as useTimelineGridSelection };
