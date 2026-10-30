import { type ReactNode, useState } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { useBackClosesSheet } from './useBackClosesSheet';

function Host() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useBackClosesSheet(open, () => setOpen(false));

  return (
    <div>
      <output data-testid="open">{String(open)}</output>
      <output data-testid="path">{location.pathname}</output>
      <output data-testid="tagged">
        {String(Boolean((location.state as { backClosesSheet?: string } | null)?.backClosesSheet))}
      </output>
      <button onClick={() => setOpen(true)}>open</button>
      <button onClick={() => setOpen(false)}>close</button>
      <button onClick={() => navigate(-1)}>back</button>
      <button onClick={() => navigate('/elsewhere')}>leave</button>
    </div>
  );
}

function click(label: string) {
  act(() => {
    fireEvent.click(screen.getByText(label));
  });
}

function renderHost(ui: ReactNode = <Host />) {
  return render(
    <MemoryRouter initialEntries={['/previous', '/memory?view=list']} initialIndex={1}>
      <Routes>
        <Route path="/memory" element={ui} />
        <Route path="/previous" element={<p>previous page</p>} />
        <Route path="/elsewhere" element={<p>elsewhere</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('useBackClosesSheet', () => {
  it('pushes a tagged entry for the same URL when the sheet opens', () => {
    renderHost();
    expect(screen.getByTestId('tagged')).toHaveTextContent('false');

    click('open');

    expect(screen.getByTestId('open')).toHaveTextContent('true');
    expect(screen.getByTestId('path')).toHaveTextContent('/memory');
    expect(screen.getByTestId('tagged')).toHaveTextContent('true');
  });

  it('Back closes the sheet and stays on the page', () => {
    renderHost();
    click('open');

    click('back');

    expect(screen.getByTestId('open')).toHaveTextContent('false');
    expect(screen.getByTestId('path')).toHaveTextContent('/memory');
    expect(screen.getByTestId('tagged')).toHaveTextContent('false');
    expect(screen.queryByText('previous page')).not.toBeInTheDocument();
  });

  it('a second Back, with the sheet closed, leaves the page as before', () => {
    renderHost();
    click('open');
    click('back');

    click('back');

    expect(screen.getByText('previous page')).toBeInTheDocument();
  });

  it("closing from the sheet's own controls pops the entry it pushed", () => {
    renderHost();
    click('open');

    click('close');

    expect(screen.getByTestId('open')).toHaveTextContent('false');
    expect(screen.getByTestId('tagged')).toHaveTextContent('false');

    // History is back to where it was: one Back now leaves the page.
    click('back');
    expect(screen.getByText('previous page')).toBeInTheDocument();
  });

  it('does not pop anything when the sheet closes because the route changed', () => {
    renderHost();
    click('open');

    click('leave');

    expect(screen.getByText('elsewhere')).toBeInTheDocument();
  });

  it('reopening after a Back close pushes a fresh entry', () => {
    renderHost();
    click('open');
    click('back');

    click('open');
    expect(screen.getByTestId('tagged')).toHaveTextContent('true');

    click('back');
    expect(screen.getByTestId('open')).toHaveTextContent('false');
    expect(screen.getByTestId('path')).toHaveTextContent('/memory');
  });
});
