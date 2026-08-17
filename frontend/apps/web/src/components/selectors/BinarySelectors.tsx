import { OptionButton } from './option-button';
import type { SelectorOption, SelectorValue } from './types';

interface ChoiceProps {
  options: SelectorOption[];
  value: SelectorValue;
  onChange: (value: SelectorValue) => void;
}

function ChoiceRow({ options, value, onChange }: ChoiceProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
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

const YES_NO: SelectorOption[] = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
];

const YES_NO_NOT_SURE: SelectorOption[] = [...YES_NO, { id: 'not_sure', label: 'Not sure' }];

const KEEP_DISCARD: SelectorOption[] = [
  { id: 'keep', label: 'Keep' },
  { id: 'discard', label: 'Discard' },
];

const APPROVE_EDIT: SelectorOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'edit', label: 'Edit' },
];

const SEGMENTED_TRUTH: SelectorOption[] = [
  { id: 'true', label: 'True' },
  { id: 'partly', label: 'Partly' },
  { id: 'false', label: 'False' },
];

export function YesNoSelector(props: Omit<ChoiceProps, 'options'> & { options?: SelectorOption[] }) {
  return <ChoiceRow {...props} options={props.options?.length ? props.options : YES_NO} />;
}

export function YesNoNotSureSelector(props: Omit<ChoiceProps, 'options'> & { options?: SelectorOption[] }) {
  return <ChoiceRow {...props} options={props.options?.length ? props.options : YES_NO_NOT_SURE} />;
}

export function KeepDiscardSelector(props: Omit<ChoiceProps, 'options'> & { options?: SelectorOption[] }) {
  return <ChoiceRow {...props} options={props.options?.length ? props.options : KEEP_DISCARD} />;
}

export function ApproveEditSelector(props: Omit<ChoiceProps, 'options'> & { options?: SelectorOption[] }) {
  return <ChoiceRow {...props} options={props.options?.length ? props.options : APPROVE_EDIT} />;
}

export function SegmentedTruthSelector(props: Omit<ChoiceProps, 'options'> & { options?: SelectorOption[] }) {
  return <ChoiceRow {...props} options={props.options?.length ? props.options : SEGMENTED_TRUTH} />;
}

export function PickAFaceSelector({
  options = [],
  value,
  onChange,
}: Omit<ChoiceProps, 'options'> & { options?: SelectorOption[] }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {options.map((option) => (
        <OptionButton
          key={option.id}
          selected={value === option.id}
          label={option.label}
          imageUrl={option.imageUrl}
          onClick={() => onChange(option.id)}
        />
      ))}
    </div>
  );
}
