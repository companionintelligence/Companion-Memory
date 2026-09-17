import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LazyView, type ViewLoader } from './LazyView';

describe('LazyView', () => {
  it('re-runs the import when "Try again" is pressed after a failed chunk load', async () => {
    // React.lazy memoizes the rejection, so a retry that reuses the original
    // lazy component can never recover. This asserts the loader is called a
    // second time and the view actually appears.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const load: ViewLoader = () => {
      calls += 1;

      return calls === 1
        ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
        : Promise.resolve({ default: () => <p>Loaded</p> });
    };

    render(<LazyView viewKey="map" load={load} />);

    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(calls).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(await screen.findByText('Loaded')).toBeInTheDocument();
    expect(calls).toBe(2);
    spy.mockRestore();
  });
});
