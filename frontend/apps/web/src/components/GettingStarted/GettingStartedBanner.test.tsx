import type { DesktopRecommendedModel } from '@ci/common';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isGettingStartedActive, markGettingStartedActive } from '@/lib/gettingStarted';

import type { MemoryTotals } from './firstSync';
import { GettingStartedBanner } from './GettingStartedBanner';

const EMPTY: MemoryTotals = {
  communications: 0,
  events: 0,
  content: 0,
  objects: 0,
  browser_activity: 0,
  position: 0,
};

const h = vi.hoisted(() => ({
  user: { id: 'u1', onboarded: true, isAdmin: true } as {
    id: string;
    onboarded: boolean;
    isAdmin: boolean;
  } | null,
  isMobile: false as boolean | undefined,
  models: [{ model: 'llama3' }] as Array<{ model: string }>,
  modelsLoading: false,
  connections: 0,
  importsFlag: true,
  snapshot: null as null | { batch: { running: number; queued: number; records: number } },
  status: {
    totals: null as MemoryTotals | null,
    indexingItems: null as number | null,
    unpushedRuns: null as number | null,
    error: null as string | null,
    failedIndexingItems: null as number | null,
    refresh: vi.fn(),
  },
  startPush: vi.fn(),
  refreshImports: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  endpoint: { backend: 'ollama', port: 11434 } as {
    backend: 'ollama' | 'openai_compatible';
    port: number;
  } | null,
  useLlmEndpoint: vi.fn(),
}));

vi.mock('@apollo/client/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@apollo/client/react')>()),
  useQuery: () => ({ data: { connections: { totalCount: h.connections } } }),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  useDeviceLayout: () => ({ isMobile: h.isMobile }),
}));

vi.mock('@ci/shadcn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/shadcn')>()),
  useToast: () => ({ toast: h.toast }),
}));

vi.mock('@/common/feature', () => ({
  useFeatures: () => ({
    isFeatureEnabled: (flag: string) => (flag === 'import.page' ? h.importsFlag : false),
  }),
}));

vi.mock('@/hooks', () => ({
  useCurrentUser: () => ({ user: h.user }),
  useModel: () => [{ activeModels: h.models, loading: h.modelsLoading }, {}],
}));

vi.mock('@/hooks/useLlmEndpoint', () => ({
  useLlmEndpoint: () => {
    h.useLlmEndpoint();

    return { config: h.endpoint };
  },
}));

vi.mock('@/components/connect/ConnectedAccountsSection', () => ({ GET_CONNECTIONS: {} }));

vi.mock('@/pages/ImportPage/useImportApi', () => ({
  useActiveImports: () => ({ snapshot: h.snapshot, error: null, refresh: h.refreshImports }),
  useImportApi: () => ({ startPush: h.startPush }),
}));

vi.mock('./useFirstSyncStatus', () => ({ useFirstSyncStatus: () => h.status }));

type Invoke = (command: string, args?: unknown) => Promise<unknown>;

/** Memory Desktop's IPC as the page sees it, answering what Settings > Model's Recommended model card reads. */
function installDesktop(answer: Partial<DesktopRecommendedModel>) {
  const invoke = vi.fn<Invoke>(async () => ({
    ownOllama: true,
    recommended: 'gemma4:e4b',
    chatModel: 'qwen3.5:122b',
    missing: ['gemma4:e4b'],
    download: { state: 'idle' },
    ...answer,
  }));
  (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__ = { invoke };

  return invoke;
}

function renderBanner() {
  return render(
    <MemoryRouter>
      <GettingStartedBanner />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  h.user = { id: 'u1', onboarded: true, isAdmin: true };
  h.isMobile = false;
  h.models = [{ model: 'llama3' }];
  h.modelsLoading = false;
  h.connections = 0;
  h.importsFlag = true;
  h.snapshot = null;
  h.status = {
    totals: EMPTY,
    indexingItems: 0,
    unpushedRuns: 0,
    error: null,
    failedIndexingItems: null,
    refresh: vi.fn(),
  };
  h.startPush.mockReset();
  h.refreshImports.mockReset();
  h.toast.success.mockReset();
  h.toast.error.mockReset();
  h.endpoint = { backend: 'ollama', port: 11434 };
  h.useLlmEndpoint.mockReset();
});

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('GettingStartedBanner', () => {
  it('is absent for a user onboarding never marked — everyone who onboarded before it existed', () => {
    renderBanner();

    expect(screen.queryByTestId('getting-started')).toBeNull();
  });

  it('is absent while there is no user yet', () => {
    markGettingStartedActive('u1');
    h.user = null;
    renderBanner();

    expect(screen.queryByTestId('getting-started')).toBeNull();
  });

  it('shows live counts of what has reached memory', () => {
    markGettingStartedActive('u1');
    h.connections = 1;
    h.status.totals = { ...EMPTY, communications: 12_400, events: 88 };
    h.status.indexingItems = 0;
    renderBanner();

    expect(screen.getByText('You’re all set')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('In your memory now: 12,400 messages · 88 events');
  });

  it('lists the checklist open on desktop, with the two things only the user can do', () => {
    markGettingStartedActive('u1');
    h.models = [];
    renderBanner();

    expect(screen.getByText('Getting started · 0 of 3')).toBeInTheDocument();
    expect(screen.getByText('Choose a chat model')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up a model' }).getAttribute('href')).toMatch(
      /\/settings\/model$/,
    );
    expect(screen.getByRole('link', { name: 'Connect a source' })).toHaveAttribute(
      'href',
      '/sources/connect',
    );
    expect(screen.getByRole('link', { name: 'Import data' })).toHaveAttribute('href', '/sources/import');
  });

  it('leaves out Import data when importing is switched off', () => {
    markGettingStartedActive('u1');
    h.importsFlag = false;
    renderBanner();

    expect(screen.queryByRole('link', { name: 'Import data' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Connect a source' })).toBeInTheDocument();
  });

  it('folds to one line on a phone until Details is pressed', () => {
    markGettingStartedActive('u1');
    h.isMobile = true;
    h.models = [];
    renderBanner();

    expect(screen.queryByText('Choose a chat model', { selector: 'li p' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));

    expect(screen.getByText('Choose a chat model', { selector: 'li p' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('offers to save an import that parsed but was never pushed, and does it', async () => {
    markGettingStartedActive('u1');
    h.status.unpushedRuns = 2;
    h.startPush.mockResolvedValue({ runs: [{}, {}] });
    renderBanner();

    expect(screen.getByText('2 imports are read but not saved yet')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save to memory' }));

    await waitFor(() => expect(h.startPush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Saving 2 imports to your memory.'));
    expect(h.status.refresh).toHaveBeenCalled();
    expect(h.refreshImports).toHaveBeenCalled();
  });

  it('says so when the save cannot start', async () => {
    markGettingStartedActive('u1');
    h.status.unpushedRuns = 1;
    h.startPush.mockRejectedValue(new Error('No runs to push'));
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: 'Save to memory' }));

    await waitFor(() => expect(h.toast.error).toHaveBeenCalledWith('No runs to push'));
  });

  it('shows a running import with its record count', () => {
    markGettingStartedActive('u1');
    h.snapshot = { batch: { running: 1, queued: 0, records: 5_000 } };
    renderBanner();

    expect(screen.getByText('1 import running')).toBeInTheDocument();
    expect(screen.getByText(/5,000 records read so far/)).toBeInTheDocument();
  });

  describe('when the sync status cannot be read', () => {
    beforeEach(() => {
      markGettingStartedActive('u1');
      h.connections = 1;
      h.status.totals = { ...EMPTY, communications: 12_400, events: 88 };
      h.status.indexingItems = 0;
      h.status.error =
        'Could not refresh your sync status. Any counts shown are from the last successful check.';
    });

    it('says the status needs attention instead of "all set", and keeps the last counts', () => {
      renderBanner();

      expect(screen.getByText('Sync status needs attention')).toBeInTheDocument();
      expect(screen.queryByText('You’re all set')).toBeNull();
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Any counts shown are from the last successful check.',
      );
      expect(screen.getByText(/In your memory now: 12,400 messages · 88 events/)).toBeInTheDocument();
    });

    it('does not call the search index done on the strength of a queue it could not read', () => {
      renderBanner();

      const memory = screen.getByText('Checking the search index…').closest('li');

      expect(memory).toHaveAttribute('data-step', 'memory');
      expect(memory).toHaveAttribute('data-status', 'unknown');
      expect(screen.queryByText('Saved and indexed.')).toBeNull();
    });

    it('offers to check again and to open System status', () => {
      renderBanner();

      fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Check again' }));

      expect(h.status.refresh).toHaveBeenCalledTimes(1);
      expect(within(screen.getByRole('alert')).getByRole('link', { name: 'System status' })).toHaveAttribute(
        'href',
        '/settings/status',
      );
    });

    it('opens System status inside Self settings on a phone', () => {
      h.isMobile = true;
      renderBanner();

      expect(screen.getByRole('link', { name: 'System status' })).toHaveAttribute(
        'href',
        '/self/settings/status',
      );
    });
  });

  it('is quiet about the sync status while it reads fine', () => {
    markGettingStartedActive('u1');
    h.status.failedIndexingItems = 0;
    renderBanner();

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('link', { name: 'System status' })).toBeNull();
  });

  it.each([
    [1, '1 indexing job has failed. Open System status for recovery.'],
    [12_000, '12,000 indexing jobs have failed. Open System status for recovery.'],
  ])('counts the search-index jobs that failed (%s)', (failed, line) => {
    markGettingStartedActive('u1');
    h.connections = 1;
    h.status.totals = { ...EMPTY, communications: 500 };
    h.status.failedIndexingItems = failed;
    renderBanner();

    expect(screen.getByRole('alert')).toHaveTextContent(line);
    expect(screen.getByRole('link', { name: 'System status' })).toBeInTheDocument();
    // A failed job is not a refresh failure: the headline and the checklist stay as they were.
    expect(screen.queryByText('Sync status needs attention')).toBeNull();
    expect(screen.getByText('You’re all set')).toBeInTheDocument();
  });

  it('goes away when dismissed, and stays away', () => {
    markGettingStartedActive('u1');
    renderBanner();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss getting started' }));

    expect(screen.queryByTestId('getting-started')).toBeNull();
    expect(isGettingStartedActive('u1')).toBe(false);
  });

  describe('a chat model that answers, inside Memory Desktop', () => {
    it('stays done and points at the recommended model the Ollama lacks', async () => {
      markGettingStartedActive('u1');
      h.models = [{ model: 'qwen3.5:122b' }];
      installDesktop({});
      renderBanner();

      expect(await screen.findByTestId('recommended-model-hint')).toHaveTextContent(
        'Memory Desktop recommends gemma4:e4b, a small model that keeps chat and summaries quick.',
      );
      expect(screen.getByText('Chat model ready').closest('li')).toHaveAttribute('data-status', 'done');
      expect(screen.getByRole('link', { name: 'Open model settings' }).getAttribute('href')).toMatch(
        /\/settings\/model$/,
      );
    });

    it('points at a recommended model pulled by hand that Memory does not use yet', async () => {
      markGettingStartedActive('u1');
      installDesktop({ missing: [] });
      renderBanner();

      expect(await screen.findByTestId('recommended-model-hint')).toHaveTextContent(
        'Memory Desktop recommends gemma4:e4b',
      );
    });

    it('names the search model when that is all the Ollama lacks', async () => {
      markGettingStartedActive('u1');
      installDesktop({ chatModel: 'gemma4:e4b', missing: ['nomic-embed-text'] });
      renderBanner();

      expect(await screen.findByTestId('recommended-model-hint')).toHaveTextContent(
        'Search needs nomic-embed-text, which your Ollama doesn’t have.',
      );
    });

    it('says nothing more once Memory runs on the recommended model', async () => {
      markGettingStartedActive('u1');
      h.models = [{ model: 'gemma4:e4b' }];
      const invoke = installDesktop({ chatModel: 'gemma4:e4b', missing: [] });
      renderBanner();

      await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_recommended_model_command', undefined));
      expect(screen.queryByTestId('recommended-model-hint')).toBeNull();
      expect(h.useLlmEndpoint).not.toHaveBeenCalled();
    });

    it('says nothing when Memory uses another inference server', async () => {
      markGettingStartedActive('u1');
      h.endpoint = { backend: 'openai_compatible', port: 13305 };
      installDesktop({});
      renderBanner();

      await waitFor(() => expect(h.useLlmEndpoint).toHaveBeenCalled());
      expect(screen.queryByTestId('recommended-model-hint')).toBeNull();
    });

    it('does not keep asking for a line it cannot show', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      try {
        markGettingStartedActive('u1');
        h.endpoint = { backend: 'openai_compatible', port: 13305 };
        const invoke = installDesktop({});
        renderBanner();

        // waitFor polls with setInterval, which is fake here. Nothing on screen changes to wake it either.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(h.useLlmEndpoint).toHaveBeenCalled();
        vi.advanceTimersByTime(60_000);
        expect(invoke).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the line when Memory Desktop fails to answer once', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      try {
        markGettingStartedActive('u1');
        const invoke = installDesktop({});
        renderBanner();

        expect(await screen.findByTestId('recommended-model-hint')).toBeInTheDocument();

        // The recheck timer is armed in an effect, which can run after the hint is in the DOM.
        // Let it run before the fake clock moves.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        invoke.mockRejectedValueOnce(new Error('Task join error'));
        vi.advanceTimersByTime(15_000);
        await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(screen.getByTestId('recommended-model-hint')).toBeInTheDocument();

        // Still asking: the next answer is heard.
        vi.advanceTimersByTime(15_000);
        expect(invoke).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps following a download when the ask after a model list reload fails', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      try {
        markGettingStartedActive('u1');
        const invoke = installDesktop({
          missing: null,
          download: { state: 'downloading', model: 'gemma4:e4b', completedBytes: 1, totalBytes: 2 },
        });
        const { rerender } = renderBanner();

        await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        invoke.mockRejectedValueOnce(new Error('Task join error'));
        h.models = [{ model: 'qwen3.5:122b' }, { model: 'llama3' }];
        rerender(
          <MemoryRouter>
            <GettingStartedBanner />
          </MemoryRouter>,
        );
        await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        // The download fails in Settings. The line comes back on the next ask.
        invoke.mockResolvedValue({
          ownOllama: true,
          recommended: 'gemma4:e4b',
          chatModel: 'qwen3.5:122b',
          missing: ['gemma4:e4b'],
          download: { state: 'failed', message: 'Your Ollama stopped answering.' },
        });
        vi.advanceTimersByTime(15_000);

        expect(await screen.findByTestId('recommended-model-hint')).toBeInTheDocument();
        expect(invoke).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('asks again when the model list reloads after a download', async () => {
      markGettingStartedActive('u1');
      const invoke = installDesktop({});
      const { rerender } = renderBanner();

      expect(await screen.findByTestId('recommended-model-hint')).toBeInTheDocument();

      invoke.mockResolvedValue({
        ownOllama: true,
        recommended: 'gemma4:e4b',
        chatModel: 'gemma4:e4b',
        missing: [],
        download: {
          state: 'done',
          downloaded: ['gemma4:e4b'],
          chatModel: 'gemma4:e4b',
          waitsForStart: false,
        },
      });
      h.models = [{ model: 'gemma4:e4b' }, { model: 'llama3' }];
      rerender(
        <MemoryRouter>
          <GettingStartedBanner />
        </MemoryRouter>,
      );

      await waitFor(() => expect(screen.queryByTestId('recommended-model-hint')).toBeNull());
    });

    it('asks again while the line is up, so a download started in Settings takes it away', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      try {
        markGettingStartedActive('u1');
        const invoke = installDesktop({});
        renderBanner();

        expect(await screen.findByTestId('recommended-model-hint')).toBeInTheDocument();

        // The recheck timer is armed in an effect, which can run after the hint is in the DOM.
        // Let it run before the fake clock moves.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(invoke).toHaveBeenCalledTimes(1);

        // Done while Memory is stopped: Memory Desktop does not ask the Ollama then.
        invoke.mockResolvedValue({
          ownOllama: true,
          recommended: 'gemma4:e4b',
          chatModel: 'gemma4:e4b',
          missing: null,
          download: {
            state: 'done',
            downloaded: ['gemma4:e4b'],
            chatModel: 'gemma4:e4b',
            waitsForStart: true,
          },
        });
        vi.advanceTimersByTime(15_000);

        await waitFor(() => expect(screen.queryByTestId('recommended-model-hint')).toBeNull());
        expect(invoke).toHaveBeenCalledTimes(2);

        // Memory started and runs on it: nothing on offer, nothing more to ask.
        invoke.mockResolvedValue({
          ownOllama: true,
          recommended: 'gemma4:e4b',
          chatModel: 'gemma4:e4b',
          missing: [],
          download: {
            state: 'done',
            downloaded: ['gemma4:e4b'],
            chatModel: 'gemma4:e4b',
            waitsForStart: false,
          },
        });
        vi.advanceTimersByTime(15_000);
        await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        vi.advanceTimersByTime(60_000);
        expect(invoke).toHaveBeenCalledTimes(3);
        expect(screen.queryByTestId('recommended-model-hint')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('brings the line back when a download started in Settings fails', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      try {
        markGettingStartedActive('u1');
        const invoke = installDesktop({});
        renderBanner();

        expect(await screen.findByTestId('recommended-model-hint')).toBeInTheDocument();

        // The recheck timer is armed in an effect, which can run after the hint is in the DOM.
        // Let it run before the fake clock moves.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        invoke.mockResolvedValue({
          ownOllama: true,
          recommended: 'gemma4:e4b',
          chatModel: 'qwen3.5:122b',
          missing: null,
          download: { state: 'downloading', model: 'gemma4:e4b', completedBytes: 1, totalBytes: 2 },
        });
        vi.advanceTimersByTime(15_000);
        await waitFor(() => expect(screen.queryByTestId('recommended-model-hint')).toBeNull());

        invoke.mockResolvedValue({
          ownOllama: true,
          recommended: 'gemma4:e4b',
          chatModel: 'qwen3.5:122b',
          missing: ['gemma4:e4b'],
          download: { state: 'failed', message: 'Your Ollama stopped answering.' },
        });
        vi.advanceTimersByTime(15_000);

        expect(await screen.findByTestId('recommended-model-hint')).toHaveTextContent(
          'Memory Desktop recommends gemma4:e4b',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps asking while the Ollama does not answer after a failed download', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      try {
        markGettingStartedActive('u1');
        // The person's Ollama stopped during the download and is not answering yet.
        const invoke = installDesktop({
          missing: null,
          download: { state: 'failed', message: 'Your Ollama stopped answering.' },
        });
        renderBanner();

        await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        vi.advanceTimersByTime(15_000);
        await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
        expect(screen.queryByTestId('recommended-model-hint')).toBeNull();

        // It answers again.
        invoke.mockResolvedValue({
          ownOllama: true,
          recommended: 'gemma4:e4b',
          chatModel: 'qwen3.5:122b',
          missing: ['gemma4:e4b'],
          download: { state: 'failed', message: 'Your Ollama stopped answering.' },
        });
        vi.advanceTimersByTime(15_000);

        expect(await screen.findByTestId('recommended-model-hint')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('says nothing to a member who is not an administrator', async () => {
      markGettingStartedActive('u1');
      h.user = { id: 'u1', onboarded: true, isAdmin: false };
      const invoke = installDesktop({});
      renderBanner();

      expect(screen.getByText('Chat model ready')).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.queryByTestId('recommended-model-hint')).toBeNull();
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  it('adds nothing to the model step in a browser or on a phone', async () => {
    markGettingStartedActive('u1');
    renderBanner();

    expect(screen.getByText('Chat model ready')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('recommended-model-hint')).toBeNull();
    expect(h.useLlmEndpoint).not.toHaveBeenCalled();
  });

  it('leaves a missing chat model to the Set up a model button', () => {
    markGettingStartedActive('u1');
    h.models = [];
    const invoke = installDesktop({});
    renderBanner();

    expect(screen.getByRole('link', { name: 'Set up a model' })).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});
