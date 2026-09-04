import { buildHeatmapRows, tallyDivergence, type HistoryDayLike } from './heatmapModel';

const HIGH_MISS = 0.35;
const MIN_SCORED = 4;

export function offScriptLine(args: {
  weekday: string;
  eveningOrNight: boolean;
  scored: number;
  missed: number;
  drift: boolean;
}): string | null {
  if (!args.drift && args.scored < MIN_SCORED) {
    return null;
  }

  const missRate = args.scored > 0 ? args.missed / args.scored : 0;
  if (!args.drift && missRate < HIGH_MISS) {
    return null;
  }

  const when = args.eveningOrNight ? 'Tonight' : 'Today';

  return `${when} does not look like your usual ${args.weekday}.`;
}

export function offScriptFromHistory(args: {
  historyDays: HistoryDayLike[];
  weekday: string;
  hour: number;
  drift?: boolean;
}): string | null {
  const { scored, missed } = tallyDivergence(buildHeatmapRows(args.historyDays, []));

  return offScriptLine({
    weekday: args.weekday,
    eveningOrNight: args.hour >= 18,
    scored,
    missed,
    drift: Boolean(args.drift),
  });
}
