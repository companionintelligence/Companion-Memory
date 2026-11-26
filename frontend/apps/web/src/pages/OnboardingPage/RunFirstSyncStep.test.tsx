import type { ReactNode } from 'react';

import { Form, useForm } from '@ci/shadcn';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RunFirstSyncStep } from './RunFirstSyncStep';

const h = vi.hoisted(() => ({
  refetch: vi.fn(async () => ({})),
  fetchJson: vi.fn(),
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: 'jwt-abc' }],
  useCurrentUser: () => ({ user: { id: 'u1' }, refetch: h.refetch }),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
}));

function Wrapper({ children }: { children: ReactNode }) {
  const form = useForm({ defaultValues: { trust_mode: 'balanced' } });

  return <Form {...form}>{children}</Form>;
}

const calledUrls = () => h.fetchJson.mock.calls.map(([url]) => url as string);

beforeEach(() => {
  h.refetch.mockClear();
  h.fetchJson.mockReset();
  h.fetchJson.mockResolvedValue({ onboarded: true });
});

describe('RunFirstSyncStep', () => {
  it('runs the sync and finishes from the primary button', async () => {
    render(<RunFirstSyncStep />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole('button', { name: 'Run my first sync and finish' }));

    await waitFor(() => expect(calledUrls()).toContain('/api/onboarding/onboard'));
    expect(calledUrls()).toContain('/api/connections/sync-now');
  });

  // Step 1 says every step is skippable. This step has no shared footer, so without its own way
  // out the only exit from onboarding was to start a sync.
  it('finishes without starting a sync', async () => {
    render(<RunFirstSyncStep />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole('button', { name: 'Finish without syncing' }));

    await waitFor(() => expect(calledUrls()).toContain('/api/onboarding/onboard'));
    expect(calledUrls()).not.toContain('/api/connections/sync-now');
    await waitFor(() => expect(h.refetch).toHaveBeenCalledTimes(1));
  });

  // The request used to be fired and forgotten, so a sync that never started looked like one that had.
  it('stays on the step and offers a retry when the first sync cannot start', async () => {
    h.fetchJson.mockImplementation(async (url: string) => {
      if (url === '/api/connections/sync-now') {
        throw new Error('offline');
      }

      return { onboarded: true };
    });
    render(<RunFirstSyncStep />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole('button', { name: 'Run my first sync and finish' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your first sync could not start.');
    expect(calledUrls()).not.toContain('/api/onboarding/onboard');
    expect(screen.getByRole('button', { name: 'Finish without syncing' })).toBeEnabled();
    // The wizard now waits on this request, so it must be bounded: a server that never answers is a failure too.
    expect(h.fetchJson).toHaveBeenCalledWith(
      '/api/connections/sync-now',
      expect.objectContaining({ timeout: expect.any(Number) }),
    );

    h.fetchJson.mockResolvedValue({ onboarded: true });
    fireEvent.click(screen.getByRole('button', { name: 'Retry first sync' }));

    await waitFor(() => expect(calledUrls()).toContain('/api/onboarding/onboard'));
    expect(calledUrls().filter((url) => url === '/api/connections/sync-now')).toHaveLength(2);
  });

  it('says so when the server has automatic syncing paused, and still lets the person finish', async () => {
    h.fetchJson.mockImplementation(async (url: string) =>
      url === '/api/connections/sync-now'
        ? { jobIds: [], enqueued: 0, skipped: 0, disabledReason: 'scheduled_sync_disabled' }
        : { onboarded: true },
    );
    render(<RunFirstSyncStep />, { wrapper: Wrapper });

    fireEvent.click(screen.getByRole('button', { name: 'Run my first sync and finish' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Automatic syncing is paused on this Memory');
    expect(calledUrls()).not.toContain('/api/onboarding/onboard');

    fireEvent.click(screen.getByRole('button', { name: 'Finish without syncing' }));

    await waitFor(() => expect(calledUrls()).toContain('/api/onboarding/onboard'));
  });
});
