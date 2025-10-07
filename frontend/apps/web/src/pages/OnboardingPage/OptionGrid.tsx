import { useState } from 'react';

import { Label, RadioGroup, cn } from '@ci/shadcn';
import { Check } from '@ci/shadcn/icons';

interface Option {
  id: string;
  title: string;
  imageUrl: string;
}

interface Props {
  options: Option[];
}

export function OptionGrid({ options }: Props) {
  const [selectedOption, setSelectedOption] = useState('');

  return (
    <RadioGroup
      value={selectedOption}
      onValueChange={setSelectedOption}
      className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6"
    >
      {options.map((option) => (
        <Label
          htmlFor={option.id}
          key={option.id}
          className={cn(
            'flex flex-col cursor-pointer rounded-xl border-2 gap-0 overflow-hidden',
            selectedOption === option.id ? 'border-teal-700' : '',
          )}
        >
          <RadioGroup.Item value={option.id} id={option.id} className="sr-only" />

          <div
            className="aspect-square bg-cover bg-center w-full md:w-64"
            style={{
              backgroundImage: `
              url(${option.imageUrl})
            `,
            }}
          />

          <div className="flex flex-row items-center justify-center h-12 gap-2">
            {selectedOption === option.id && <Check className="h-5 w-5 text-teal-700" />}
            {option.title}
          </div>
        </Label>
      ))}
    </RadioGroup>
  );
}
