import { MockedProvider } from '@apollo/client/testing';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { NextForecast } from './BranchialTree';
import { GET_BRANCHIAL, type BranchialTreeData } from './useBranchial';

function tree(over: Partial<BranchialTreeData> = {}): BranchialTreeData {
  return {
    question: 'What happens next',
    guessed: false,
    steps: [
      {
        id: 'morning',
        label: 'Morning',
        startTime: '2026-08-22T10:00:00Z',
        branches: [
          {
            id: 'morning:WORK',
            title: 'WORK',
            l0: 'WORK',
            mass: 0.7,
            why: 'From your usual rhythm.',
            permutations: [{ id: 'standup', title: 'standup', mass: 0.6 }],
          },
          {
            id: 'morning:LEISURE',
            title: 'LEISURE',
            l0: 'LEISURE',
            mass: 0.3,
            why: '',
            permutations: [{ id: 'walk', title: 'walk', mass: 0.9 }],
          },
        ],
      },
    ],
    ...over,
  };
}

describe('NextForecast', () => {
  it('walks competing futures horizontally when two branches pass', async () => {
    render(
      <MockedProvider
        mocks={[{ request: { query: GET_BRANCHIAL }, result: { data: { branchialForecast: tree() } } }]}
      >
        <NextForecast />
      </MockedProvider>,
    );

    expect(await screen.findByTestId('next-forecast')).toBeInTheDocument();
    expect(screen.getByText('Morning')).toBeInTheDocument();
    expect(screen.getByText(/Path: standup/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /walk/ }));
    expect(screen.getByText(/Path: walk/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Name from memory' })).toBeInTheDocument();
  });

  it('renders 1–3 sentences when a single named future passes', async () => {
    const single = tree({
      steps: [
        {
          id: 'morning',
          label: 'Morning',
          startTime: '2026-08-22T10:00:00Z',
          branches: [
            {
              id: 'morning:WORK',
              title: 'WORK',
              l0: 'WORK',
              mass: 0.7,
              why: '',
              permutations: [{ id: 'standup', title: 'standup', mass: 0.6 }],
            },
          ],
        },
      ],
    });

    render(
      <MockedProvider
        mocks={[{ request: { query: GET_BRANCHIAL }, result: { data: { branchialForecast: single } } }]}
      >
        <NextForecast />
      </MockedProvider>,
    );

    expect(await screen.findByText('Morning — standup')).toBeInTheDocument();
    expect(screen.queryByText(/Path:/)).not.toBeInTheDocument();
  });

  it('renders nothing when the tree is empty or only UNKNOWN', async () => {
    render(
      <MockedProvider
        mocks={[
          {
            request: { query: GET_BRANCHIAL },
            result: { data: { branchialForecast: { question: 'next', guessed: false, steps: [] } } },
          },
        ]}
      >
        <NextForecast />
      </MockedProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('next-forecast')).not.toBeInTheDocument();
  });
});
