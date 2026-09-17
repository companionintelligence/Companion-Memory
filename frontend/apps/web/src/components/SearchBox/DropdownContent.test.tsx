/**
 * The advanced-filter panel's own logic: the date-range label (After/Before/
 * range/"Any time"), and tag add/remove wired through to the `?tags=` URL
 * state via `useDropdown`. EntityTypeFilter has its own test file and
 * ActivityFilter is exercised through the explorer toolbar's (it also needs an
 * Apollo mock this component doesn't care about), so both are stubbed here to
 * keep this suite about what DropdownContent itself computes and wires up.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { DropdownContent } from './DropdownContent';
import { DropdownProvider } from './useDropdown';

vi.mock('./EntityTypeFilter', () => ({ EntityTypeFilter: () => <div>entity type filter</div> }));
vi.mock('./ActivityFilter', () => ({ ActivityFilter: () => <div>activity filter</div> }));

function LocationProbe() {
  const location = useLocation();

  return <div data-testid="query">{location.search}</div>;
}

function params(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('query').textContent ?? '');
}

function renderContent(
  props: Partial<React.ComponentProps<typeof DropdownContent>> = {},
  route = '/memory/events',
) {
  return renderWithProviders(
    <DropdownProvider args={[{ changeSearchParams: true }]}>
      <DropdownContent {...props} />
      <LocationProbe />
    </DropdownProvider>,
    { route },
  );
}

describe('DropdownContent — date range label', () => {
  it('reads "Any time" when neither end of the range is set', () => {
    renderContent({}, '/memory/events');

    expect(screen.getByRole('button', { name: /any time/i })).toBeInTheDocument();
  });

  it('reads "After <date>" with only a start date', () => {
    const from = '2026-01-05T00:00:00.000Z';
    renderContent({}, `/memory?from=${encodeURIComponent(from)}`);

    const expected = `After ${new Date(from).toLocaleDateString()}`;
    expect(screen.getByRole('button', { name: expected })).toBeInTheDocument();
  });

  it('reads "Before <date>" with only an end date', () => {
    const to = '2026-01-10T00:00:00.000Z';
    renderContent({}, `/memory?to=${encodeURIComponent(to)}`);

    const expected = `Before ${new Date(to).toLocaleDateString()}`;
    expect(screen.getByRole('button', { name: expected })).toBeInTheDocument();
  });

  it('reads a full range when both ends are set', () => {
    const from = '2026-01-05T00:00:00.000Z';
    const to = '2026-01-10T00:00:00.000Z';
    renderContent({}, `/memory?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);

    const expected = `${new Date(from).toLocaleDateString()} – ${new Date(to).toLocaleDateString()}`;
    expect(screen.getByRole('button', { name: expected })).toBeInTheDocument();
  });
});

describe('DropdownContent — tags', () => {
  it('adds a typed tag to the URL and renders it as a chip', async () => {
    renderContent({}, '/memory/events');

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'vacation' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => expect(params().get('tags')).toBe('vacation'));
    expect(screen.getByText('vacation')).toBeInTheDocument();
  });

  it('adds a second tag alongside the first, rather than replacing it', async () => {
    renderContent({}, '/memory?tags=vacation');

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'family' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    await waitFor(() => expect(params().get('tags')).toBe('vacation,family'));
  });

  it('removes a tag from the URL when its chip is dismissed', async () => {
    renderContent({}, '/memory?tags=vacation,work');

    fireEvent.click(screen.getByRole('button', { name: /remove tag.*vacation/i }));

    await waitFor(() => expect(params().get('tags')).toBe('work'));
    expect(screen.queryByText('vacation')).not.toBeInTheDocument();
    // The other tag is untouched.
    expect(screen.getByText('work')).toBeInTheDocument();
  });

  it('clears the tags param entirely once the last tag is removed', async () => {
    renderContent({}, '/memory?tags=vacation');

    fireEvent.click(screen.getByRole('button', { name: /remove tag.*vacation/i }));

    await waitFor(() => expect(params().has('tags')).toBe(false));
  });
});

describe('DropdownContent — Save Search', () => {
  it('is hidden when saving is not supported', () => {
    renderContent({ saveSupported: false });

    expect(screen.queryByRole('button', { name: /save search/i })).not.toBeInTheDocument();
  });

  it('calls onSave with the entity types currently selected', () => {
    const onSave = vi.fn();
    renderContent({ onSave });

    fireEvent.click(screen.getByRole('button', { name: /save search/i }));

    // Nothing narrowed the type filter in this route, so every type is "selected".
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toBeInstanceOf(Array);
    expect((onSave.mock.calls[0][0] as string[]).length).toBeGreaterThan(0);
  });
});
