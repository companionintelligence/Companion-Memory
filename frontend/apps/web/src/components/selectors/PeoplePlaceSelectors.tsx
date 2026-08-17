import { RadioListSelector, TagCloudSelector } from './ChoiceSelectors';
import { OptionButton } from './option-button';
import type { SelectorOption, SelectorValue } from './types';

interface Props {
  options?: SelectorOption[];
  value: SelectorValue;
  onChange: (value: SelectorValue) => void;
  center?: { lat: number; lng: number };
}

export function PersonPickerSelector(props: Props) {
  return <RadioListSelector {...props} />;
}

export function AttendeesSelector(props: Props) {
  return <TagCloudSelector {...props} />;
}

const RELATIONSHIP_DEFAULTS = [
  { id: 'friend', label: 'Friend' },
  { id: 'family', label: 'Family' },
  { id: 'colleague', label: 'Colleague' },
  { id: 'partner', label: 'Partner' },
  { id: 'acquaintance', label: 'Acquaintance' },
  { id: 'neighbor', label: 'Neighbor' },
  { id: 'other', label: 'Other' },
];

export function RelationshipSelector({ options = [], value, onChange }: Props) {
  return (
    <RadioListSelector
      value={value}
      onChange={onChange}
      options={options.length > 0 ? options : RELATIONSHIP_DEFAULTS}
    />
  );
}

export function DropPinSelector({ value, onChange, center }: Props) {
  const point =
    value && typeof value === 'object' && 'lat' in value
      ? (value as { lat: number; lng: number })
      : (center ?? { lat: 0.5, lng: 0.5 });

  return (
    <button
      type="button"
      className="relative h-32 w-full overflow-hidden rounded-md border border-border bg-muted"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onChange({
          lat: Number(((event.clientY - rect.top) / rect.height).toFixed(3)),
          lng: Number(((event.clientX - rect.left) / rect.width).toFixed(3)),
        });
      }}
    >
      <span
        className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
        style={{ top: `${point.lat * 100}%`, left: `${point.lng * 100}%` }}
      />
    </button>
  );
}

export function VenueListSelector(props: Props) {
  return <RadioListSelector {...props} />;
}

export function HomeWorkOtherSelector({ options = [], value, onChange }: Props) {
  const defaults =
    options.length > 0
      ? options
      : [
          { id: 'home', label: 'Home' },
          { id: 'work', label: 'Work' },
          { id: 'other', label: 'Other' },
        ];

  return (
    <div className="flex flex-wrap gap-2">
      {defaults.map((option) => (
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

const PLACE_ACTIVITY_DEFAULTS = [
  { id: 'live', label: 'Live here' },
  { id: 'work', label: 'Work here' },
  { id: 'visit', label: 'Visit' },
  { id: 'eat', label: 'Eat / drink' },
  { id: 'exercise', label: 'Exercise' },
  { id: 'shop', label: 'Shop' },
  { id: 'other', label: 'Other' },
];

export function WhatDidYouDoHereSelector({ options = [], value, onChange }: Props) {
  return (
    <RadioListSelector
      value={value}
      onChange={onChange}
      options={options.length > 0 ? options : PLACE_ACTIVITY_DEFAULTS}
    />
  );
}
