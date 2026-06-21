import { Button, Input, Label } from '@ci/shadcn';
import { useSearchParams } from 'react-router-dom';

const toIso = (date: Date) => date.toISOString().slice(0, 10);

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);

  return toIso(date);
}

// "When" presets, each producing the {from,to} window (empty = unbounded).
const PRESETS: { label: string; range: () => { from: string; to: string } }[] = [
  { label: 'Today', range: () => ({ from: toIso(new Date()), to: toIso(new Date()) }) },
  { label: 'Last 7 days', range: () => ({ from: daysAgo(6), to: toIso(new Date()) }) },
  { label: 'Last 30 days', range: () => ({ from: daysAgo(29), to: toIso(new Date()) }) },
  { label: 'This year', range: () => ({ from: `${new Date().getFullYear()}-01-01`, to: toIso(new Date()) }) },
  { label: 'All time', range: () => ({ from: '', to: '' }) },
];

/**
 * Date-range ("when") filter for the search dropdown. Reads/writes the `from`/`to`
 * URL params that the Memory explorer consumes (mapped to the Search query's
 * startTime/endTime). Offers quick presets plus an explicit range.
 */
export function DateRangeFilter() {
  const [searchParams, setSearchParams] = useSearchParams();

  const from = searchParams.get('from') ?? '';
  const to = searchParams.get('to') ?? '';

  const setParam = (key: 'from' | 'to', value: string) => {
    const params = new URLSearchParams(searchParams);

    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }

    setSearchParams(params);
  };

  const applyRange = (range: { from: string; to: string }) => {
    const params = new URLSearchParams(searchParams);

    if (range.from) {
      params.set('from', range.from);
    } else {
      params.delete('from');
    }

    if (range.to) {
      params.set('to', range.to);
    } else {
      params.delete('to');
    }

    setSearchParams(params);
  };

  const clear = () => applyRange({ from: '', to: '' });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label className="font-medium">When</Label>
        {(from || to) && (
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={clear}>
            Clear
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <Button
            key={preset.label}
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => applyRange(preset.range())}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="date"
          aria-label="From date"
          value={from}
          max={to || undefined}
          onChange={(e) => setParam('from', e.target.value)}
          className="w-40"
        />
        <span className="text-muted-foreground text-sm">to</span>
        <Input
          type="date"
          aria-label="To date"
          value={to}
          min={from || undefined}
          onChange={(e) => setParam('to', e.target.value)}
          className="w-40"
        />
      </div>
    </div>
  );
}
