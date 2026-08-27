import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { ConsentLock } from './ConsentLock';
import { consentLockLabel, type ConsentLockState } from './consentProvenance';

const meta: Meta<typeof ConsentLock> = {
  title: 'Asks/Consent Lock',
  component: ConsentLock,
  parameters: { layout: 'centered' },
  args: { onOpen: fn() },
};

export default meta;
type Story = StoryObj<typeof ConsentLock>;

export const Sealed: Story = { args: { state: 'sealed' } };
export const Consented: Story = { args: { state: 'consented' } };
export const Pending: Story = { args: { state: 'pending' } };
export const NoRecord: Story = { args: { state: 'open' } };

const ALL_STATES: ConsentLockState[] = ['sealed', 'consented', 'pending', 'open'];

/**
 * All four states together, each with the sentence it stands for.
 *
 * This is the story the documentation screenshots — the states only make sense
 * relative to each other, and the point being made is that the COMMON one
 * (`consented`: real consent, unsigned channel) is deliberately unremarkable
 * rather than a warning.
 */
export const AllStates: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className="flex max-w-lg flex-col gap-3">
      {ALL_STATES.map((state) => (
        <div key={state} className="flex items-start gap-3">
          <div className="w-28 shrink-0">
            <ConsentLock state={state} onOpen={fn()} />
          </div>
          <p className="text-muted-foreground pt-0.5 text-xs">{consentLockLabel(state).meaning}</p>
        </div>
      ))}
    </div>
  ),
};
