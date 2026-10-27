import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LazyView, type ViewLoader } from './LazyView';

describe('LazyView', () => {
  const reload = vi.fn();
  const realLocation = window.location;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // jsdom's location.reload is not implemented and its property cannot be spied on.
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload } });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    vi.restoreAllMocks();
    reload.mockReset();
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

  it('reloads the page on "Try again" after a chunk failed to download, once back online', async () => {
    // Chromium keeps a failed module fetch in the document's module map, so a
    // fresh import() of the same chunk rejects without a request. Only a reload
    // fetches it again.
    const { load, calls } = failingOnce(
      new Error('Failed to fetch dynamically imported module: /assets/MapView.js'),
    );

    render(<LazyView viewKey="map" load={load} />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(calls()).toBe(1);
  });

  it('re-runs the import in place while still offline, keeping the message instead of reloading', async () => {
    // React.lazy memoizes the rejection, so a retry that reuses the original
    // lazy component can never recover. This asserts the loader is called a
    // second time and the view actually appears.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { load, calls } = failingOnce(new Error('Failed to fetch dynamically imported module'));

    render(<LazyView viewKey="map" load={load} />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Loaded')).toBeInTheDocument();
    expect(calls()).toBe(2);
    expect(reload).not.toHaveBeenCalled();
  });

  it('remounts in place after an error that is not a failed download', async () => {
    const { load, calls } = failingOnce(new Error('Cannot read properties of undefined'));

    render(<LazyView viewKey="map" load={load} />);

    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Loaded')).toBeInTheDocument();
    expect(calls()).toBe(2);
    expect(reload).not.toHaveBeenCalled();
  });
});
