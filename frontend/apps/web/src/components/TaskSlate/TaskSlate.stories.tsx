import type { ComponentProps } from 'react';

import type { Meta, StoryObj } from '@storybook/react';

import { groupIntoSections } from '@/pages/PlanPage/taskSections';
import type { PlanTask } from '@/pages/PlanPage/usePlanTasks';

import { TaskSlate } from './TaskSlate';

type Props = ComponentProps<typeof TaskSlate>;

const TODAY = '2026-08-23';

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: 't',
    title: 'Untitled',
    status: 'open',
    priority: 3,
    ...overrides,
  };
}

const TASKS: PlanTask[] = [
  task({ id: 'p1', title: 'Review goals for Backlog Grooming', status: 'proposed' }),
  task({
    id: 'p2',
    title: 'Watch a movie',
    status: 'proposed',
  }),
  task({
    id: 'u1',
    title: 'Pre-Read Prep',
    dueAt: '2026-08-25T17:00:00.000Z',
    estimatedMinutes: 120,
  }),
  task({
    id: 'u2',
    title: 'Call the dentist',
    dueAt: '2026-08-20T17:00:00.000Z',
  }),
];

const meta: Meta<Props> = {
  title: 'Schedule/TaskSlate',
  component: TaskSlate,
  parameters: { layout: 'centered' },
  decorators: [
    (Story) => (
      <div style={{ width: 900 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<Props>;

export const Populated: Story = {
  args: {
    sections: groupIntoSections(TASKS, TODAY).filter(
      (section) => section.key === 'proposed' || section.key === 'unscheduled',
    ),
    loading: false,
    onDismissProposed: () => {},
  },
};

/** Nothing waiting — should read as calm, not as a failure. */
export const Empty: Story = {
  args: { sections: [], loading: false },
};

export const Loading: Story = {
  args: { sections: [], loading: true },
};
