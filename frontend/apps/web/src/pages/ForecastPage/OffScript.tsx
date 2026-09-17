import type { HistoryDayLike } from './heatmapModel';
import { offScriptFromHistory } from './offScriptLine';

export function OffScript({
  historyDays,
  drift = false,
  hour = new Date().getHours(),
}: {
  historyDays: HistoryDayLike[];
  drift?: boolean;
  hour?: number;
}) {
  const weekday = new Date().toLocaleDateString(undefined, { weekday: 'long' });
  const line = offScriptFromHistory({
    historyDays,
    weekday,
    hour,
    drift,
  });

  if (!line) {
    return null;
  }

  return (
    <p className="text-sm text-muted-foreground" data-testid="off-script">
      {line}
    </p>
  );
}
