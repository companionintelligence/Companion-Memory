import { TimelineView } from '../TimelineView';

/** Only Event cards — the Events tab shows the account's activity stream. */
const EVENT_ONLY_TYPES: ReadonlySet<string> = new Set(['EventType']);

/**
 * The Events tab: the shared timeline restricted to Event entities and grouped
 * by the event's KIND (`event_type`: visited, messaged, traveled, …) instead of
 * by date. Narrow the kinds via the What bar's Events dropdown (the shared
 * `eventTypes` search param), which filters the underlying search itself.
 */
export function EventsView() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div className="mx-auto w-full max-w-3xl">
        <TimelineView typeFilter={EVENT_ONLY_TYPES} groupByEventType />
      </div>
    </div>
  );
}
