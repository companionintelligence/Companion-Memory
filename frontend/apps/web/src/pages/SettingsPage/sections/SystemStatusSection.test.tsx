import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SystemStatusSection } from './SystemStatusSection';

// One stable `headers`: a new object per render would change `refresh`, and with it the 30 s timer.
const h = vi.hoisted(() => ({ fetchJson: vi.fn(), headers: {} as Record<string, string> }));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
}));
vi.mock('@/hooks/useSessionAuth', () => ({ useSessionAuth: () => ({ ready: true, headers: h.headers }) }));
vi.mock('@/common/feature', () => ({ useFeatures: () => ({ isFeatureEnabled: () => true }) }));

function operations(overrides: Record<string, unknown> = {}) {
  return {
    at: '2026-11-23T12:00:00.000Z',
    ok: true,
    syncEnabled: true,
    dependencies: [
      { name: 'postgres', ok: true },
      { name: 'files', ok: true },
    ],
    connections: { connected: 1, needsSignIn: 0, syncing: 0, lastSyncedAt: null },
    processing: { waiting: 2, active: 1, failed: 0, delayed: 0 },
    backup: null,
    ...overrides,
  };
}

const renderSection = () =>
  render(
    <MemoryRouter>
      <SystemStatusSection />
    </MemoryRouter>,
  );

beforeEach(() => h.fetchJson.mockReset());

describe('SystemStatusSection', () => {
  it('shows every component as ready, and the jobs it is waiting on', async () => {
    h.fetchJson.mockResolvedValue(operations());
    renderSection();

    expect(await screen.findByText('Your database · Ready')).toBeInTheDocument();
    expect(screen.getByText('Photos and attachments · Ready')).toBeInTheDocument();
    expect(screen.getByText(/2 waiting · 1\s+processing · 0 failed jobs/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('link', { name: 'View jobs' })).toHaveAttribute('href', '/jobs');
    expect(screen.getByRole('link', { name: 'Manage sources' })).toHaveAttribute('href', '/sources/connect');
  });

  it('keeps the previous result, marked stale, when a refresh fails', async () => {
    h.fetchJson.mockResolvedValueOnce(operations());
    renderSection();
    await screen.findByText('Your database · Ready');

    h.fetchJson.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The results below are from the last successful check and may be out of date.',
    );
    expect(screen.getByText(/^Last successful check/)).toBeInTheDocument();
    expect(screen.getByText('Your database · Ready')).toBeInTheDocument();
  });

  it('checks again every 30 seconds while the page is visible, and not while it is hidden', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    h.fetchJson.mockResolvedValue(operations());
    renderSection();
    await screen.findByText('Your database · Ready');

    const tick = setIntervalSpy.mock.calls.find(([, delay]) => delay === 30_000)?.[0] as () => void;
    h.fetchJson.mockClear();
    tick();
    expect(h.fetchJson).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    tick();
    delete (document as { visibilityState?: unknown }).visibilityState;
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
  });

  it('shows an administrator a backup that is overdue as needing attention', async () => {
    const backup = { state: 'overdue', lastSuccessAt: '2026-11-01T00:00:00.000Z', bytes: 5_242_880 };
    h.fetchJson.mockResolvedValue(operations({ backup }));
    renderSection();

    expect(await screen.findByText(/Appliance backup · Needs attention/)).toBeInTheDocument();
    expect(screen.getByText(/Last complete backup:/)).toBeInTheDocument();
    expect(screen.getByText('5.0 MB in the last snapshot')).toBeInTheDocument();
  });

  it('shows no backup section to anyone else', async () => {
    h.fetchJson.mockResolvedValue(operations({ backup: null }));
    renderSection();

    await screen.findByText('Your database · Ready');
    expect(screen.queryByText(/Appliance backup/)).toBeNull();
  });
});
