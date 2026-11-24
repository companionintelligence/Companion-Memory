import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LazyView, type ViewLoader } from './LazyView';

const h = vi.hoisted(() => ({
  memoryAnswers: vi.fn<() => Promise<boolean>>(),
  pageServedByApi: vi.fn<() => boolean>(),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  memoryAnswers: h.memoryAnswers,
  pageServedByApi: h.pageServedByApi,
}));

describe('LazyView', () => {
  const reload = vi.fn();
  const realLocation = window.location;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.memoryAnswers.mockResolvedValue(true);
    h.pageServedByApi.mockReturnValue(true);
    // jsdom's location.reload is not implemented and its property cannot be spied on.
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
  });

  // The spies and `reload`'s calls are reset by vitest.config.ts (restoreMocks, clearMocks).
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  });

  function failingOnce(error: Error): { load: ViewLoader; calls: () => number } {
    let calls = 0;

    return {
      load: () => {
        calls += 1;

        return calls === 1 ? Promise.reject(error) : Promise.resolve({ default: () => <p>Loaded</p> });
      },
      calls: () => calls,
    };
  }

  it('reloads the page on "Try again" after a chunk failed to download, once Memory answers', async () => {
    // Chromium keeps a failed module fetch in the document's module map, so a
    // fresh import() of the same chunk rejects without a request. Only a reload
    // fetches it again.
    const { load, calls } = failingOnce(
      new Error('Failed to fetch dynamically imported module: /assets/MapView.js'),
    );

    render(<LazyView viewKey="map" load={load} />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(h.memoryAnswers).toHaveBeenCalledTimes(1);
    expect(calls()).toBe(1);
  });

  // `navigator.onLine` is true on any network, Memory up or not, and the connection
  // probe can be 30 s old. Try again asks Memory when it is pressed.
  it('asks Memory when Try again is pressed, whatever navigator.onLine says', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    h.memoryAnswers.mockResolvedValue(false);
    const { load, calls } = failingOnce(new Error('Failed to fetch dynamically imported module'));

    render(<LazyView viewKey="map" load={load} />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    // Memory did not answer, so no reload onto a page that would fail too: the in-place retry runs.
    expect(await screen.findByText('Loaded')).toBeInTheDocument();
    expect(h.memoryAnswers).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(calls()).toBe(2);
  });

  // The native shells carry the code in the bundle, so Memory being down does not stop a reload.
  it('reloads without asking Memory when the code comes with the app, as in the native shells', async () => {
    h.pageServedByApi.mockReturnValue(false);
    h.memoryAnswers.mockResolvedValue(false);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const { load, calls } = failingOnce(new Error('Failed to fetch dynamically imported module'));

    render(<LazyView viewKey="map" load={load} />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(h.memoryAnswers).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
  });

  it('retries in place when the code comes with the app and there is no network', async () => {
    h.pageServedByApi.mockReturnValue(false);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { load, calls } = failingOnce(new Error('Failed to fetch dynamically imported module'));

    render(<LazyView viewKey="map" load={load} />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Loaded')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(h.memoryAnswers).not.toHaveBeenCalled();
    expect(calls()).toBe(2);
  });

  it('says it is checking while Memory has not answered, and checks once for two presses', async () => {
    let answer: (answers: boolean) => void = () => undefined;
    h.memoryAnswers.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));
    const { load } = failingOnce(new Error('Failed to fetch dynamically imported module'));

    render(<LazyView viewKey="map" load={load} />);

    const button = await screen.findByRole('button', { name: /try again/i });
    fireEvent.click(button);

    expect(await screen.findByText('Checking whether Memory answers…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(h.memoryAnswers).toHaveBeenCalledTimes(1);

    answer(true);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('reloads when the chunk that failed was the view stylesheet', async () => {
    // Vite rejects with its own message when a chunk's CSS fails, before it
    // starts the import(). The Map and Timeline views carry CSS.
    const { load, calls } = failingOnce(new Error('Unable to preload CSS for /assets/MapView-abc.css'));

    render(<LazyView viewKey="map" load={load} />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(calls()).toBe(1);
  });

  it('re-runs the import in place instead of reloading while Memory does not answer', async () => {
    // React.lazy memoizes the rejection, so a retry that reuses the original
    // lazy component can never recover. This asserts the loader is called a
    // second time and the view actually appears.
    h.memoryAnswers.mockResolvedValue(false);
    const { load, calls } = failingOnce(new Error('Failed to fetch dynamically imported module'));

    render(<LazyView viewKey="map" load={load} />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Loaded')).toBeInTheDocument();
    expect(calls()).toBe(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload when the view was left while Memory was being asked', async () => {
    let answer: (answers: boolean) => void = () => undefined;
    h.memoryAnswers.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));
    const { load } = failingOnce(new Error('Failed to fetch dynamically imported module'));

    const { unmount } = render(<LazyView viewKey="map" load={load} />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));
    unmount();
    answer(true);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reload).not.toHaveBeenCalled();
  });

  it('remounts in place after an error that is not a failed download, without asking Memory', async () => {
    const { load, calls } = failingOnce(new Error('Cannot read properties of undefined'));

    render(<LazyView viewKey="map" load={load} />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Loaded')).toBeInTheDocument();
    expect(calls()).toBe(2);
    expect(reload).not.toHaveBeenCalled();
    expect(h.memoryAnswers).not.toHaveBeenCalled();
  });
});
