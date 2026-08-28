import { MockedProvider } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ForagePanel } from './ForagePanel';
import { GET_FORAGE, type ForageTrial } from './useForage';

function trial(over: Partial<ForageTrial> = {}): ForageTrial {
  return {
    question: 'where is Sam on Saturday',
    horizon: 'saturday',
    pin: null,
    resolved: false,
    ready: true,
    pick: 'beach',
    texture: null,
    textureMass: null,
    permutationBranch: 'beach',
    branches: [
      { id: 'beach', mass: 0.7, ready: true, past: false, pinned: false, topTexture: 'jerry' },
      { id: 'office', mass: 0.2, ready: false, past: false, pinned: false, topTexture: 'solo' },
      { id: 'errands', mass: 0.1, ready: false, past: false, pinned: false, topTexture: 'solo' },
    ],
    permutations: [
      { label: 'jerry', mass: 0.6 },
      { label: 'tom', mass: 0.2 },
      { label: 'colleague', mass: 0.1 },
      { label: 'solo', mass: 0.1 },
    ],
    interests: [
      { person: 'jerry', activities: ['surf', 'tacos'] },
      { person: 'tom', activities: ['chess', 'coffee'] },
    ],
    attention: [
      {
        gaze: 0,
        id: 'calendar_saturday',
        label: 'calendar: Saturday beach trip',
        read: true,
        g: 1.2,
        epistemic: 0.8,
        risk: 0.3,
        ambiguity: 0.1,
      },
      {
        gaze: 1,
        id: 'packed_shorts',
        label: 'content: board shorts in the bag',
        read: false,
        g: 1.4,
        epistemic: 0.6,
        risk: 0.4,
        ambiguity: 0.2,
      },
    ],
    reads: [{ itemId: 'calendar_saturday', cue: 'beach_mention', g: 1.2, epistemic: 0.8, branchDelta: [] }],
    ...over,
  };
}

describe('ForagePanel', () => {
  it('renders the Sam Saturday trial from the forage query', async () => {
    render(
      <MockedProvider mocks={[{ request: { query: GET_FORAGE }, result: { data: { forage: trial() } } }]}>
        <ForagePanel />
      </MockedProvider>,
    );

    expect(await screen.findByTestId('forage-panel')).toHaveTextContent('where is Sam on Saturday');
    expect(screen.getByText(/committed beach/)).toBeInTheDocument();
    expect(screen.getByText(/surf, tacos/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sample packed shorts/ })).toBeInTheDocument();
  });

  it('renders nothing when forage is unavailable', async () => {
    render(
      <MockedProvider mocks={[{ request: { query: GET_FORAGE }, result: { data: { forage: null } } }]}>
        <ForagePanel />
      </MockedProvider>,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('forage-panel')).not.toBeInTheDocument();
  });
});
