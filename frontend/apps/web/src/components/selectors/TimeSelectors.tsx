import { Slider } from '@ci/shadcn';

import { OptionButton } from './option-button';
import type { SelectorOption, SelectorValue } from './types';

interface Props {
  options?: SelectorOption[];
  value: SelectorValue;
  onChange: (value: SelectorValue) => void;
  min?: number;
  max?: number;
}

function asList(value: SelectorValue): string[] {
  return Array.isArray(value) ? value : [];
}

function asRange(value: SelectorValue, min: number, max: number): { start: number; end: number } {
  if (value && typeof value === 'object' && 'start' in value && 'end' in value) {
    return value as { start: number; end: number };
  }

  return { start: min, end: max };
}

export function DayChipsSelector({ options = [], value, onChange }: Props) {
  const selected = asList(value);
  const days =
    options.length > 0
      ? options
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => ({
          id: label.toLowerCase(),
          label,
        }));

  return (
    <div className="flex flex-wrap gap-2">
      {days.map((option) => {
        const on = selected.includes(option.id);

        return (
          <OptionButton
            key={option.id}
            selected={on}
            label={option.label}
            onClick={() =>
              onChange(on ? selected.filter((id) => id !== option.id) : [...selected, option.id])
            }
          />
        );
      })}
    </div>
  );
}

export function TripWindowSelector({ value, onChange, min = 0, max = 100 }: Props) {
  const range = asRange(value, min, max);

  return (
    <div className="flex flex-col gap-2">
      <Slider
        min={min}
        max={max}
        step={1}
        value={[range.start, range.end]}
        onValueChange={(next) => onChange({ start: next[0] ?? min, end: next[1] ?? max })}
      />
      <p className="text-xs text-muted-foreground">
        {range.start} – {range.end}
      </p>
    </div>
  );
}

export function PresetScopeSelector({ options = [], value, onChange }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <OptionButton
          key={option.id}
          selected={value === option.id}
          label={option.label}
          onClick={() => onChange(option.id)}
        />
      ))}
    </div>
  );
}

const RECURRENCE_DEFAULTS = [
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
  { id: 'rarely', label: 'Rarely' },
];

export function RecurrenceSelector({ options = [], ...props }: Props) {
  return <PresetScopeSelector {...props} options={options.length > 0 ? options : RECURRENCE_DEFAULTS} />;
}

export function ActivityScrubSelector(props: Props) {
  return <TripWindowSelector {...props} />;
}

export function DeepWorkSelector({ options = [], value, onChange }: Props) {
  return <DayChipsSelector options={options} value={value} onChange={onChange} />;
}
