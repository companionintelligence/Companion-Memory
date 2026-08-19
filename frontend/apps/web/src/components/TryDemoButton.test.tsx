import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TryDemoButton } from './TryDemoButton';

/**
 * The reviewer's entire path onto a self-hosted product is this one button, so the
 * failure modes that matter are: rendering a demo button in a build that has no demo
 * server (a dead button reads as a broken product), and handing off to the app after
 * a demo server that never answered.
 *
 * `getDemoServerOrigin` is mocked rather than driven through `import.meta.env`, which
 * Vite inlines at build time and no test in another module can set. The env-reading
 * and URL rules it wraps are covered directly in `lib/demoServer.node.test.ts`.
 */

const navigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();

  return { ...actual, useNavigate: () => navigate };
});

const h = vi.hoisted(() => ({
  origin: null as string | null,
  connectToDemoServer: vi.fn(),
}));

vi.mock('@/lib/demoServer', () => ({
  getDemoServerOrigin: () => h.origin,
  connectToDemoServer: h.connectToDemoServer,
}));

beforeEach(() => {
  h.origin = 'https://demo.ci.computer';
  h.connectToDemoServer.mockReset().mockResolvedValue(undefined);
  navigate.mockReset();
});

describe('TryDemoButton', () => {
  it('renders nothing when the build has no demo server (a self-hoster build)', () => {
    h.origin = null;

    const { container } = render(<TryDemoButton />);

    expect(container).toBeEmptyDOMElement();
  });

  it('connects to the configured origin and hands off to the app on tap', async () => {
    render(<TryDemoButton />);
    fireEvent.click(screen.getByRole('button', { name: /try the demo/i }));

    await waitFor(() => expect(h.connectToDemoServer).toHaveBeenCalledWith('https://demo.ci.computer'));
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('surfaces an unreachable demo server instead of navigating into a broken app', async () => {
    h.connectToDemoServer.mockRejectedValue(new Error('Memory Server responded with 503'));

    render(<TryDemoButton />);
    fireEvent.click(screen.getByRole('button', { name: /try the demo/i }));

    expect(await screen.findByText(/could not reach the demo memory server/i)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('reports a timeout distinctly from a refusal', async () => {
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    h.connectToDemoServer.mockRejectedValue(aborted);

    render(<TryDemoButton />);
    fireEvent.click(screen.getByRole('button', { name: /try the demo/i }));

    expect(await screen.findByText(/did not respond in time/i)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('names the origin and says the instance is Lifescope-hosted and shared', () => {
    render(<TryDemoButton />);

    expect(screen.getByText(/https:\/\/demo\.ci\.computer/)).toBeInTheDocument();
    expect(screen.getByText(/hosted by lifescope/i)).toBeInTheDocument();
  });

  it('is disabled while the host screen is busy with its own request', () => {
    render(<TryDemoButton disabled />);

    expect(screen.getByRole('button', { name: /try the demo/i })).toBeDisabled();
  });
});
