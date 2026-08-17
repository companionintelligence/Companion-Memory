import { OptionButton } from './option-button';
import type { SelectorOption, SelectorValue } from './types';

interface Props {
  options?: SelectorOption[];
  value: SelectorValue;
  onChange: (value: SelectorValue) => void;
}

function asList(value: SelectorValue): string[] {
  return Array.isArray(value) ? value : [];
}

export function RadioListSelector({ options = [], value, onChange }: Props) {
  return (
    <div className="flex flex-col gap-2">
      {options.map((option) => (
        <OptionButton
          key={option.id}
          selected={value === option.id}
          label={option.label}
          description={option.description}
          onClick={() => onChange(option.id)}
        />
      ))}
    </div>
  );
}

export function ChecklistSelector({ options = [], value, onChange }: Props) {
  const selected = asList(value);

  return (
    <div className="flex flex-col gap-2">
      {options.map((option) => {
        const on = selected.includes(option.id);

        return (
          <OptionButton
            key={option.id}
            selected={on}
            label={option.label}
            description={option.description}
            onClick={() =>
              onChange(on ? selected.filter((id) => id !== option.id) : [...selected, option.id])
            }
          />
        );
      })}
    </div>
  );
}

export function TagCloudSelector({ options = [], value, onChange }: Props) {
  const selected = asList(value);

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
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

export function ABSelector({ options = [], value, onChange }: Props) {
  const pair = options.slice(0, 2);

  return (
    <div className="grid grid-cols-2 gap-2">
      {pair.map((option) => (
        <OptionButton
          key={option.id}
          selected={value === option.id}
          label={option.label}
          description={option.description}
          imageUrl={option.imageUrl}
          onClick={() => onChange(option.id)}
        />
      ))}
    </div>
  );
}

const FEELING_DEFAULTS = [
  { id: 'happy', label: 'Happy' },
  { id: 'calm', label: 'Calm' },
  { id: 'tired', label: 'Tired' },
  { id: 'stressed', label: 'Stressed' },
  { id: 'excited', label: 'Excited' },
  { id: 'sad', label: 'Sad' },
  { id: 'focused', label: 'Focused' },
  { id: 'anxious', label: 'Anxious' },
  { id: 'content', label: 'Content' },
];

export function FeelingGridSelector({ options = [], value, onChange }: Props) {
  const cells = options.length > 0 ? options : FEELING_DEFAULTS;

  return (
    <div className="grid grid-cols-3 gap-2">
      {cells.map((option) => (
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

export function PersonFindSelector(props: Props) {
  return <RadioListSelector {...props} />;
}
