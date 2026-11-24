import { act, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { useLeaveGuard } from './useLeaveGuard';

function Page({ unsaved, ask }: { unsaved: boolean; ask: boolean }) {
  const guard = useLeaveGuard({ unsaved, ask });
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <>
      <p data-testid="where">{pathname}</p>
      <Link to="/elsewhere">Elsewhere</Link>
      <button type="button" onClick={() => guard.allow(() => navigate('/notes/its-id', { replace: true }))}>
        Own move
      </button>
      {guard.asking ? (
        <div role="alertdialog">
          <button type="button" onClick={guard.stay}>
            Stay
          </button>
          <button type="button" onClick={guard.leave}>
            Leave
          </button>
        </div>
      ) : null}
    </>
  );
}

function renderPage(props: { unsaved: boolean; ask: boolean }) {
  const tree = (current: { unsaved: boolean; ask: boolean }) => (
    <MemoryRouter initialEntries={['/notes/new']}>
      <Routes>
        <Route path="/notes/:id" element={<Page {...current} />} />
        <Route path="/elsewhere" element={<p>Somewhere else</p>} />
      </Routes>
    </MemoryRouter>
  );
  const view = render(tree(props));

  return { rerender: (next: { unsaved: boolean; ask: boolean }) => view.rerender(tree(next)) };
}

function unloadIsStopped() {
  const event = new Event('beforeunload', { cancelable: true });

  window.dispatchEvent(event);

  return event.defaultPrevented;
}

describe('useLeaveGuard', () => {
  it('stops the tab closing only while something is unsaved', () => {
    const view = renderPage({ unsaved: true, ask: false });

    expect(unloadIsStopped()).toBe(true);

    view.rerender({ unsaved: false, ask: false });

    expect(unloadIsStopped()).toBe(false);
  });

  it('holds a link while armed, and lets it through on Leave', () => {
    renderPage({ unsaved: true, ask: true });

    fireEvent.click(screen.getByText('Elsewhere'));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByText('Somewhere else')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Leave'));

    expect(screen.getByText('Somewhere else')).toBeInTheDocument();
  });

  it('keeps the link held when asking stops but something is still unsaved', () => {
    // Between a save failing and the page noting the failure, `ask` is off for a render.
    const view = renderPage({ unsaved: true, ask: true });

    fireEvent.click(screen.getByText('Elsewhere'));
    act(() => view.rerender({ unsaved: true, ask: false }));

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.queryByText('Somewhere else')).not.toBeInTheDocument();
  });

  it('lets the held link through by itself once nothing is unsaved', () => {
    const view = renderPage({ unsaved: true, ask: true });

    fireEvent.click(screen.getByText('Elsewhere'));
    act(() => view.rerender({ unsaved: false, ask: false }));

    expect(screen.getByText('Somewhere else')).toBeInTheDocument();
  });

  it("lets the page's own navigation through without asking", () => {
    renderPage({ unsaved: true, ask: true });

    fireEvent.click(screen.getByText('Own move'));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/notes/its-id');
  });
});
