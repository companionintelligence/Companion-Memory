import { Slider } from '@ci/shadcn';

import { RadioListSelector, ChecklistSelector } from './ChoiceSelectors';
import { OptionButton } from './option-button';
import type { SelectorMediaItem, SelectorNode, SelectorOption, SelectorValue } from './types';

interface Props {
  options?: SelectorOption[];
  images?: SelectorMediaItem[];
  nodes?: SelectorNode[];
  value: SelectorValue;
  onChange: (value: SelectorValue) => void;
  min?: number;
  max?: number;
}

export function PickImagesSelector({ images = [], value, onChange }: Props) {
  const selected = Array.isArray(value) ? value : [];

  return (
    <div className="grid grid-cols-3 gap-2">
      {images.map((image) => {
        const on = selected.includes(image.id);

        return (
          <button
            key={image.id}
            type="button"
            aria-pressed={on}
            className={`overflow-hidden rounded-md border ${on ? 'border-primary' : 'border-border'}`}
            onClick={() => onChange(on ? selected.filter((id) => id !== image.id) : [...selected, image.id])}
          >
            <img src={image.url} alt={image.label ?? ''} className="h-20 w-full object-cover" />
          </button>
        );
      })}
    </div>
  );
}

export function CropFocusSelector({ images = [], value, onChange }: Props) {
  const image = images[0];
  const point =
    value && typeof value === 'object' && 'x' in value
      ? (value as { x: number; y: number })
      : { x: 0.5, y: 0.5 };

  if (!image) {
    return null;
  }

  return (
    <button
      type="button"
      className="relative h-40 w-full overflow-hidden rounded-md border border-border"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onChange({
          x: Number(((event.clientX - rect.left) / rect.width).toFixed(3)),
          y: Number(((event.clientY - rect.top) / rect.height).toFixed(3)),
        });
      }}
    >
      <img src={image.url} alt={image.label ?? ''} className="h-full w-full object-cover" />
      <span
        className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary"
        style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
      />
    </button>
  );
}

export function MediaMomentSelector({ value, onChange, min = 0, max = 100 }: Props) {
  const current = typeof value === 'number' ? value : min;

  return (
    <div className="flex flex-col gap-2">
      <Slider
        min={min}
        max={max}
        step={1}
        value={[current]}
        onValueChange={(next) => onChange(next[0] ?? min)}
      />
      <p className="text-xs text-muted-foreground">{current}</p>
    </div>
  );
}

export function TapHubSelector({ nodes = [], value, onChange }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {nodes.map((node) => (
        <OptionButton
          key={node.id}
          selected={value === node.id}
          label={node.label}
          onClick={() => onChange(node.id)}
        />
      ))}
    </div>
  );
}

const CONNECTION_DEFAULTS = [
  { id: 'KNOWS', label: 'Knows' },
  { id: 'INTERESTED_IN', label: 'Interested in' },
  { id: 'LIVES_AT', label: 'Lives at' },
  { id: 'WORKS_AT', label: 'Works at' },
  { id: 'RELATED_TO', label: 'Related to' },
];

export function ConnectionTypeSelector({ options = [], value, onChange }: Props) {
  return (
    <RadioListSelector
      value={value}
      onChange={onChange}
      options={options.length > 0 ? options : CONNECTION_DEFAULTS}
    />
  );
}

function nextDays(count: number): Array<{ id: string; label: string }> {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() + index);

    return {
      id: date.toISOString().slice(0, 10),
      label: date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
    };
  });
}

export function PickADaySelector({ options = [], value, onChange }: Props) {
  return (
    <RadioListSelector
      value={value}
      onChange={onChange}
      options={options.length > 0 ? options : nextDays(7)}
    />
  );
}

export function SourceOfTruthSelector(props: Props) {
  return <RadioListSelector {...props} />;
}

export function AcceptSlotSelector(props: Props) {
  return <RadioListSelector {...props} />;
}

export function AcceptEditsSelector(props: Props) {
  return <ChecklistSelector {...props} />;
}
