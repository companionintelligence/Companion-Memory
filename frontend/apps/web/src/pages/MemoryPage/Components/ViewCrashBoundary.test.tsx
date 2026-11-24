import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ViewCrashBoundary } from './ViewCrashBoundary';

function Boom(): never {
  throw new Error('boom');
}

describe('ViewCrashBoundary', () => {
  it('renders the fallback instead of unmounting the page when a child throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <ViewCrashBoundary fallback={<p>Could not stay open</p>}>
        <Boom />
      </ViewCrashBoundary>,
    );

    expect(screen.getByText('Could not stay open')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('retries the child after the fallback asks', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let shouldThrow = true;

    function Flaky() {
      if (shouldThrow) {
        throw new Error('boom');
      }

      return <p>Recovered</p>;
    }

    render(
      <ViewCrashBoundary fallback={(retry) => <button onClick={retry}>Try again</button>}>
        <Flaky />
      </ViewCrashBoundary>,
    );

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('Recovered')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('catches a thrown value that is falsy, such as a promise rejected with no reason', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function ThrowsUndefined(): never {
      throw undefined;
    }

    render(
      <ViewCrashBoundary fallback={<p>Could not stay open</p>}>
        <ThrowsUndefined />
      </ViewCrashBoundary>,
    );

    expect(screen.getByText('Could not stay open')).toBeInTheDocument();
    spy.mockRestore();
  });
});
