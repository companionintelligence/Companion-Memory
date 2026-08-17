import { useState } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import { SelectorRenderer } from './SelectorRenderer';
import { SelectorShell } from './SelectorShell';
import { SELECTOR_TYPES, selectorSubmitsOnSelect, type SelectorSpec, type SelectorValue } from './types';

const sampleOptions = [
  { id: 'a', label: 'Documentaries' },
  { id: 'b', label: 'Comedies' },
  { id: 'c', label: 'Dramas' },
];

function specFor(type: SelectorSpec['type']): SelectorSpec {
  return {
    type,
    prompt: `Sample ${type.split('_').join(' ')} prompt`,
    hint: 'Catalog fixture',
    options: sampleOptions,
    stem: 'I usually',
    scaffold: 'Start with what you remember.',
    images: [{ id: 'img-1', url: 'https://placehold.co/160x120', label: 'Still' }],
    nodes: [
      { id: 'n1', label: 'Home' },
      { id: 'n2', label: 'Work' },
    ],
    min: 0,
    max: 10,
  };
}

function Playground({ spec }: { spec: SelectorSpec }) {
  const [value, setValue] = useState<SelectorValue>(null);

  return (
    <div className="w-[420px] rounded-lg border border-border p-4">
      <SelectorShell
        prompt={spec.prompt}
        hint={spec.hint}
        canSubmit={value !== null && value !== ''}
        hideSave={selectorSubmitsOnSelect(spec.type)}
        onSubmit={() => undefined}
        onSkip={() => undefined}
      >
        <SelectorRenderer spec={spec} value={value} onChange={setValue} />
      </SelectorShell>
    </div>
  );
}

const meta: Meta<typeof Playground> = {
  component: Playground,
  parameters: { layout: 'centered' },
};

export default meta;

type Story = StoryObj<typeof Playground>;

export const YesNo: Story = { args: { spec: specFor('yes_no') } };

export const AllTypes: Story = {
  render: () => (
    <div className="grid max-h-[80vh] grid-cols-2 gap-4 overflow-auto p-4">
      {SELECTOR_TYPES.map((type) => (
        <Playground key={type} spec={specFor(type)} />
      ))}
    </div>
  ),
};
