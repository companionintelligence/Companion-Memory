import { StrictMode, useState } from 'react';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { useBackClosesSheet } from './useBackClosesSheet';

function Host() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useBackClosesSheet(open, () => setOpen(false));

  return (
    <div>
      <output data-testid="open">{String(open)}</output>
      <output data-testid="path">{location.pathname}</output>
      <button onClick={() => setOpen(true)}>open</button>
      <button onClick={() => setOpen(false)}>close</button>
    </div>
  );
}

describe('useBackClosesSheet under BrowserRouter (real history)', () => {
  it('Back closes the sheet and stays on the page', async () => {
    window.history.replaceState(null, '', '/previous');
    window.history.pushState(null, '', '/memory?view=list');
    render(
      <StrictMode>
        <BrowserRouter useTransitions={false}>
          <Routes>
            <Route path="/memory" element={<Host />} />
            <Route path="/previous" element={<p>previous page</p>} />
          </Routes>
        </BrowserRouter>
      </StrictMode>,
    );
    act(() => {
      fireEvent.click(screen.getByText('open'));
    });
    expect(screen.getByTestId('open')).toHaveTextContent('true');
    const lenAfterOpen = window.history.length;

    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.getByTestId('open')).toHaveTextContent('false'));
    // give any stray navigate(-1) a chance to land
    await new Promise((r) => setTimeout(r, 50));
    await act(async () => {});

    expect(window.location.pathname).toBe('/memory');
    expect(screen.queryByText('previous page')).not.toBeInTheDocument();
    console.log(
      'history length after open',
      lenAfterOpen,
      'after back',
      window.history.length,
      'path',
      window.location.pathname,
    );
  });
});
