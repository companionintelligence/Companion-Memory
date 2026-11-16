import type { DesktopModelDownload, DesktopRecommendedModel } from '@ci/common';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecommendedModelCard } from './RecommendedModelCard';

const GB = 1024 * 1024 * 1024;

/** Settings > Model > Inference server as Memory Desktop sets it up: the Ollama on port 11434. */
const OLLAMA = { backend: 'ollama', port: 11434 } as const;

type Invoke = (command: string, args?: unknown) => Promise<unknown>;

/** Memory Desktop's IPC as this page sees it: `window.__TAURI_INTERNALS__.invoke`. */
function installDesktop(invoke: Invoke) {
  const spy = vi.fn(invoke);
  (window as unknown as { __TAURI_INTERNALS__?: { invoke: Invoke } }).__TAURI_INTERNALS__ = { invoke: spy };

  return spy;
}

function status(overrides: Partial<DesktopRecommendedModel> = {}): DesktopRecommendedModel {
  return {
    ownOllama: true,
    recommended: 'gemma4:e4b',
    chatModel: 'qwen3.5:122b',
    missing: ['gemma4:e4b'],
    download: { state: 'idle' },
    ...overrides,
  };
}

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('RecommendedModelCard', () => {
  it('renders nothing outside Memory Desktop', async () => {
    const { container } = render(<RecommendedModelCard endpoint={OLLAMA} canDownload onSwitched={vi.fn()} />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a Memory Desktop that cannot answer, or has nothing to offer', async () => {
    for (const answer of [
      () => Promise.reject(new Error('command get_recommended_model_command not found')),
      () => Promise.resolve(status({ ownOllama: false, missing: [], chatModel: 'gemma4:e4b' })),
      () => Promise.resolve(status({ missing: [], chatModel: 'gemma4:e4b' })),
      () => Promise.resolve(status({ missing: null })),
    ]) {
      const invoke = installDesktop(answer);
      const { container, unmount } = render(
        <RecommendedModelCard endpoint={OLLAMA} canDownload onSwitched={vi.fn()} />,
      );

      await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_recommended_model_command', undefined));
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('renders nothing when Memory uses another inference server than the Ollama on port 11434', async () => {
    for (const endpoint of [
      { backend: 'openai_compatible', port: 13305 },
      { backend: 'openai_compatible', port: 11434 },
      { backend: 'ollama', port: 11435 },
      null,
    ] as const) {
      const invoke = installDesktop(async () => status());
      const { container, unmount } = render(
        <RecommendedModelCard endpoint={endpoint} canDownload onSwitched={vi.fn()} />,
      );

      await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_recommended_model_command', undefined));
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('offers the download, follows it and reloads the models once Memory runs on the recommended model', async () => {
    const timeline: DesktopModelDownload[] = [
      { state: 'downloading', model: 'gemma4:e4b', completedBytes: 1 * GB, totalBytes: 4 * GB },
      { state: 'switching', model: 'gemma4:e4b' },
      { state: 'done', downloaded: ['gemma4:e4b'], chatModel: 'gemma4:e4b' },
    ];
    let step = -1;
    // Before the button: the offer. After it, every look moves one step along the timeline.
    const invoke = installDesktop(async (command) => {
      if (command === 'download_recommended_model_command') {
        step = 0;
      } else if (step >= 0) {
        step = Math.min(step + 1, timeline.length - 1);
      }

      return step < 0 ? status() : status({ download: timeline[step] });
    });
    const onSwitched = vi.fn();

    render(<RecommendedModelCard endpoint={OLLAMA} canDownload onSwitched={onSwitched} />);

    expect(
      await screen.findByText(/Memory Desktop recommends gemma4:e4b.*Memory runs on qwen3\.5:122b for now/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download recommended model' }));

    expect(await screen.findByText('Downloading gemma4:e4b into your Ollama…')).toBeInTheDocument();
    expect(screen.getByText('1.0 GB of 4.0 GB')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('download_recommended_model_command', undefined);

    expect(
      await screen.findByText(/Restarting Memory on gemma4:e4b/, {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText('Downloaded gemma4:e4b. Memory now runs on gemma4:e4b.', {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(onSwitched).toHaveBeenCalledTimes(1);
  });

  it('says why a download failed and offers it again', async () => {
    installDesktop(async () =>
      status({
        missing: ['nomic-embed-text', 'gemma4:e4b'],
        download: {
          state: 'failed',
          message: 'There is not enough free disk space for gemma4:e4b. Free up some space, then try again.',
        },
      }),
    );

    render(<RecommendedModelCard endpoint={OLLAMA} canDownload onSwitched={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'There is not enough free disk space for gemma4:e4b. Free up some space, then try again.',
    );
    expect(screen.getByText(/Search also needs nomic-embed-text/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('claims nothing about the models of an Ollama that stopped answering', async () => {
    installDesktop(async () =>
      status({
        missing: null,
        download: {
          state: 'failed',
          message:
            'Your Ollama stopped answering while it was downloading gemma4:e4b. Check that Ollama is running, then try again.',
        },
      }),
    );

    render(<RecommendedModelCard endpoint={OLLAMA} canDownload onSwitched={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your Ollama stopped answering');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText(/Your Ollama has gemma4:e4b now/)).not.toBeInTheDocument();
    expect(screen.queryByText(/doesn.t have it/)).not.toBeInTheDocument();
  });

  it('does not claim Memory runs on the recommended model while the Ollama lacks it', async () => {
    // An Ollama with no chat model at launch leaves `.env` naming the recommended one.
    installDesktop(async () => status({ chatModel: 'gemma4:e4b', missing: ['gemma4:e4b'] }));

    render(<RecommendedModelCard endpoint={OLLAMA} canDownload onSwitched={vi.fn()} />);

    expect(
      await screen.findByText(/Memory asks for it, but your Ollama doesn.t have it yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/runs on gemma4:e4b for now/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Memory restarts on/)).not.toBeInTheDocument();
  });

  it('says only what it knows when Memory Desktop could not read which model Memory asks for', async () => {
    installDesktop(async () => status({ chatModel: null }));

    render(<RecommendedModelCard endpoint={OLLAMA} canDownload onSwitched={vi.fn()} />);

    expect(await screen.findByText(/Your Ollama doesn.t have it\.$/)).toBeInTheDocument();
    expect(screen.queryByText(/Memory asks for it/)).not.toBeInTheDocument();
    expect(screen.queryByText(/runs on .* for now/)).not.toBeInTheDocument();
  });

  it('reports a restart that failed after the switch without contradicting itself', async () => {
    installDesktop(async () =>
      status({
        chatModel: 'gemma4:e4b',
        missing: [],
        download: {
          state: 'failed',
          message:
            'gemma4:e4b is downloaded, but Memory did not restart with it. Quit Memory Desktop and open it again to switch to it.',
        },
      }),
    );

    render(<RecommendedModelCard endpoint={OLLAMA} canDownload onSwitched={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Memory did not restart with it');
    expect(screen.queryByText(/still runs on/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it("shows Memory Desktop's answer when a download cannot start", async () => {
    installDesktop(async (command) => {
      if (command === 'download_recommended_model_command') {
        throw 'Your Ollama did not answer. Check that it is running, then try again.';
      }

      return status();
    });

    render(<RecommendedModelCard endpoint={OLLAMA} canDownload onSwitched={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download recommended model' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your Ollama did not answer. Check that it is running, then try again.',
    );
  });

  it('offers to switch when the model arrived some other way but leaves the button to an administrator', async () => {
    installDesktop(async () => status({ missing: [] }));

    const { unmount } = render(<RecommendedModelCard endpoint={OLLAMA} canDownload onSwitched={vi.fn()} />);

    expect(
      await screen.findByText('Your Ollama has gemma4:e4b now, but Memory still runs on qwen3.5:122b.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use recommended model' })).toBeInTheDocument();
    unmount();

    installDesktop(async () => status());
    render(<RecommendedModelCard endpoint={OLLAMA} canDownload={false} onSwitched={vi.fn()} />);

    expect(
      await screen.findByText('An administrator of this Companion can download it here.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('tells someone who is not an administrator that only a switch is on offer when nothing is missing', async () => {
    installDesktop(async () => status({ missing: [] }));

    render(<RecommendedModelCard endpoint={OLLAMA} canDownload={false} onSwitched={vi.fn()} />);

    expect(
      await screen.findByText('An administrator of this Companion can switch to it here.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
