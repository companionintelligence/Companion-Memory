import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Intro } from './Intro';

vi.mock('@/hooks', () => ({
  useCurrentUser: () => ({
    user: { id: 'u1', name: 'Bennett' },
  }),
}));

describe('Intro typing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('plays once and stays on the finished text if the step mounts again', async () => {
    const first = render(<Intro />);

    for (let step = 0; step < 40; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }

    expect(screen.getByText('Your companion will learn more as you interact.')).toBeInTheDocument();
    expect(screen.getByText('Welcome, Bennett')).toBeInTheDocument();

    first.unmount();
    render(<Intro />);

    expect(screen.getByText('Your companion will learn more as you interact.')).toBeInTheDocument();
    expect(screen.getByText('Welcome, Bennett')).toBeInTheDocument();
  });
});
