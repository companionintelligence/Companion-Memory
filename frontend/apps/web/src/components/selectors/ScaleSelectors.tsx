import { Button, Slider } from '@ci/shadcn';

import { OptionButton } from './option-button';
import type { SelectorOption, SelectorValue } from './types';

interface Props {
  options?: SelectorOption[];
  value: SelectorValue;
  onChange: (value: SelectorValue) => void;
  min?: number;
  max?: number;
}

function asNumber(value: SelectorValue, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function asList(value: SelectorValue, fallback: string[]): string[] {
  return Array.isArray(value) ? value : fallback;
}

export function IntensitySelector({ value, onChange, min = 1, max = 5 }: Props) {
  const current = asNumber(value, min);

  return (
    <div className="flex flex-col gap-2">
      <Slider
        min={min}
        max={max}
        step={1}
        value={[current]}
        onValueChange={(next) => onChange(next[0] ?? min)}
      />
      <p className="text-xs text-muted-foreground">
        {current} / {max}
      </p>
    </div>
  );
}

export function PrivacySliderSelector({ value, onChange }: Props) {
  return <IntensitySelector value={value} onChange={onChange} min={0} max={100} />;
}

export function DragRankSelector({ options = [], value, onChange }: Props) {
  const order = asList(
    value,
    options.map((option) => option.id),
  );

  const move = (index: number, direction: -1 | 1) => {
    const next = [...order];
    const swap = index + direction;
    if (swap < 0 || swap >= next.length) {
      return;
    }

    const current = next[index];
    const other = next[swap];
    if (current === undefined || other === undefined) {
      return;
    }

    next[index] = other;
    next[swap] = current;
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      {order.map((id, index) => {
        const option = options.find((item) => item.id === id);

        return (
          <div key={id} className="flex items-center gap-2">
            <OptionButton selected={false} label={option?.label ?? id} onClick={() => undefined} />
            <Button type="button" size="sm" variant="outline" onClick={() => move(index, -1)}>
              Up
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => move(index, 1)}>
              Down
            </Button>
          </div>
        );
      })}
    </div>
  );
}
