/**
 * The "What" entity-type filter: a checklist menu backed by the explorer's
 * `?excludedEntityTypes=` URL state (via useDropdown), with a trigger label
 * that summarizes the selection (all / none / one / "N Entity Types").
 */
import { useState } from 'react';

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { EntityTypeFilter } from './EntityTypeFilter';
import {
  AVAILABLE_ENTITY_TYPES,
  DropdownProvider,
  excludedEntityTypesFor,
  HIDDEN_ENTITY_TYPES,
} from './useDropdown';

function LocationProbe() {
  const location = useLocation();

  return <div data-testid="query">{location.search}</div>;
}

function params(): URLSearchParams {
  return new URLSearchParams(screen.getByTestId('query').textContent ?? '');
}

function renderFilter(
  props: Partial<React.ComponentProps<typeof EntityTypeFilter>> = {},
  route = '/memory/events',
) {
  return renderWithProviders(
    <DropdownProvider args={[{ changeSearchParams: true }]}>
      <EntityTypeFilter modal={false} {...props} />
      <LocationProbe />
    </DropdownProvider>,
    { route },
  );
}

/**
 * Radix's DropdownMenuTrigger opens on pointerdown (for mouse input), not
 * click — a bare click() never toggles it. Takes the trigger element itself
 * (captured right after render, before the menu's own buttons join it as
 * `button`-role siblings) rather than re-querying by role each time.
 */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0 });
}

describe('EntityTypeFilter — trigger label', () => {
  it('reads "All Entity Types" with nothing excluded', () => {
    renderFilter();

    expect(screen.getByRole('button', { name: /all entity types/i })).toBeInTheDocument();
  });

  it('reads "No Entity Types" when every type is excluded', () => {
    renderFilter({}, `/memory/events?excludedEntityTypes=${AVAILABLE_ENTITY_TYPES.join(',')}`);

    expect(screen.getByRole('button', { name: /no entity types/i })).toBeInTheDocument();
  });

  it('names the single remaining type rather than saying "1 Entity Types"', () => {
    const allButPerson = AVAILABLE_ENTITY_TYPES.filter((t) => t !== 'Person');
    renderFilter({}, `/memory/events?excludedEntityTypes=${allButPerson.join(',')}`);

    expect(screen.getByRole('button', { name: 'Person' })).toBeInTheDocument();
  });

  it('shows a count once more than one, but fewer than all, types are selected', () => {
    renderFilter({}, '/memory/events?excludedEntityTypes=Person,Place');

    const remaining = AVAILABLE_ENTITY_TYPES.length - 2;
    expect(screen.getByRole('button', { name: `${remaining} Entity Types` })).toBeInTheDocument();
  });

  it('uses the given label instead, with an icon, regardless of selection', () => {
    renderFilter({ label: 'What' }, '/memory/events?excludedEntityTypes=Person,Place');

    const button = screen.getByRole('button', { name: 'What' });
    expect(button).toBeInTheDocument();
    expect(button.querySelector('svg')).not.toBeNull();
  });
});

describe('EntityTypeFilter — toggling from the menu', () => {
  it('excludes a type when its checkbox is unchecked, and reflects it in the URL', async () => {
    renderFilter();
    openMenu(screen.getByRole('button'));

    const person = await screen.findByRole('menuitemcheckbox', { name: 'Person' });
    expect(person).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(person);

    // Narrowing any visible type also excludes Answer/Concept so they don't
    // leak into a "People only" (etc.) result set.
    await waitFor(() =>
      expect(params().get('excludedEntityTypes')?.split(',').sort()).toEqual(
        excludedEntityTypesFor(AVAILABLE_ENTITY_TYPES.filter((t) => t !== 'Person')).sort(),
      ),
    );
  });

  it('"Clear all" excludes every type; "Select all" brings them all back', async () => {
    renderFilter();
    const trigger = screen.getByRole('button');
    openMenu(trigger);

    fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
    await waitFor(() =>
      expect(params().get('excludedEntityTypes')?.split(',').sort()).toEqual(
        [...AVAILABLE_ENTITY_TYPES, ...HIDDEN_ENTITY_TYPES].sort(),
      ),
    );
    // The trigger's own accessible name reflects the new state live, without
    // needing to close and reopen the menu.
    expect(trigger).toHaveAccessibleName(/no entity types/i);

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));

    await waitFor(() => expect(params().has('excludedEntityTypes')).toBe(false));
    expect(trigger).toHaveAccessibleName(/all entity types/i);
  });

  it('disables "Select all" when everything is already selected, and "Clear all" when nothing is', async () => {
    renderFilter();
    openMenu(screen.getByRole('button'));

    expect(await screen.findByRole('button', { name: 'Select all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear all' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Select all' })).not.toBeDisabled();
  });
});

describe('EntityTypeFilter — caller-owned trigger and open state', () => {
  it('opens from the caller’s trigger, handed the selected types, and follows a controlled open state', async () => {
    function Host() {
      const [open, setOpen] = useState(false);

      return (
        <>
          <div data-testid="open">{String(open)}</div>
          <button type="button" onClick={() => setOpen(false)}>
            Close from outside
          </button>
          <EntityTypeFilter
            modal={false}
            open={open}
            onOpenChange={setOpen}
            renderTrigger={(selected) => <button type="button">{`What row: ${selected.length}`}</button>}
          />
        </>
      );
    }

    renderWithProviders(
      <DropdownProvider args={[{ changeSearchParams: true }]}>
        <Host />
      </DropdownProvider>,
      { route: '/memory?includedEntityTypes=Person,Event' },
    );

    const trigger = await screen.findByRole('button', { name: 'What row: 2' });

    openMenu(trigger);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByTestId('open')).toHaveTextContent('true');

    fireEvent.click(screen.getByRole('button', { name: 'Close from outside', hidden: true }));
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});
