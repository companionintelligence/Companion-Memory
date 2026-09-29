/**
 * The Memory "What" bar. Its category chips collapse to a bare icon and only
 * expand their label on hover — which on a phone (Capacitor / WKWebView, no
 * hover) meant a selected filter was an anonymous glyph (#2312). These tests
 * pin the selection-driven reveal: an engaged filter shows its value, an idle
 * one stays collapsed so the desktop hover animation still has somewhere to go.
 */
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DropdownProvider, excludedEntityTypesFor } from '@/components/SearchBox/useDropdown';
import { renderWithProviders } from '@/test/renderWithProviders';

import { MemoryEntityTypeNav } from './MemoryEntityTypeNav';

// When / How / sort ride along in the same bar but are covered by
// ExplorerToolbar's own tests; stubbing them keeps this file to the What chips
// (and off Radix's Select, which jsdom can't drive without extra scaffolding).
vi.mock('@/pages/MemoryPage/Components/ExplorerToolbar/ExplorerToolbar', () => ({
  MemoryExplorerFilterControls: () => null,
}));

/** The URL the What bar writes when it narrows browsing to `types`. */
function narrowedRoute(types: string[], extra = '') {
  return `/memory?excludedEntityTypes=${excludedEntityTypesFor(types).join(',')}${extra}`;
}

function renderNav(route = '/memory') {
  return renderWithProviders(
    <DropdownProvider args={[{ changeSearchParams: true }]}>
      <MemoryEntityTypeNav />
    </DropdownProvider>,
    { route },
  );
}

/** The chip's animated label span — the element the reveal classes land on. */
function labelOf(buttonName: string | RegExp) {
  const button = screen.getByRole('button', { name: buttonName });
  const label = button.querySelector<HTMLSpanElement>('span');

  if (!label) {
    throw new Error(`No label span in the "${button.getAttribute('aria-label')}" chip`);
  }

  return { button, label };
}

function expectRevealed(label: HTMLElement) {
  expect(label).toHaveClass('opacity-100');
  expect(label).not.toHaveClass('max-w-0');
  expect(label).not.toHaveClass('opacity-0');
}

function expectCollapsed(label: HTMLElement) {
  expect(label).toHaveClass('max-w-0');
  expect(label).toHaveClass('opacity-0');
  // The desktop affordance survives: hover/focus/open still expand it.
  expect(label).toHaveClass('group-hover:max-w-[7rem]');
}

describe('MemoryEntityTypeNav — alignment', () => {
  it('keeps the What strip on the top edge when the other filters wrap to a second line', () => {
    renderNav();

    const nav = screen.getByRole('navigation', { name: 'What to show in Memory' });

    // `items-center` sat the one-line What strip in the middle of a filter
    // block that had wrapped onto two rows. Top alignment keeps What on the
    // first line with When / How / the rest.
    expect(nav).toHaveClass('items-start');
    expect(nav).not.toHaveClass('items-center');
  });
});

describe('MemoryEntityTypeNav — phone accordion', () => {
  it('keeps the filter bar collapsed until the chevron opens it', () => {
    renderNav();

    const toggle = screen.getByRole('button', { name: 'Filters' });
    const nav = screen.getByRole('navigation', { name: 'What to show in Memory' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'memory-filter-bar');
    expect(nav).toHaveClass('max-device:hidden');
    expect(nav).toHaveClass('device:flex');

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(nav).toHaveClass('flex');
    expect(nav).not.toHaveClass('max-device:hidden');
    expect(nav).toHaveClass('device:flex');
  });

  it('reports how many filters are active while the bar is collapsed', () => {
    renderNav('/memory?hasLocation=1&semantic=1');

    expect(screen.getByRole('button', { name: 'Filters, 2 active' })).toBeInTheDocument();
  });
});

describe('MemoryEntityTypeNav — label reveal', () => {
  it('keeps a selected category readable without hover', () => {
    renderNav(narrowedRoute(['Person']));

    const { label } = labelOf('People');

    expect(label).toHaveTextContent('People');
    expectRevealed(label);
  });

  it('leaves categories that are not selected collapsed to their icon', () => {
    renderNav(narrowedRoute(['Person']));

    expectCollapsed(labelOf('Places').label);
    expectCollapsed(labelOf('Messages').label);
  });

  it('collapses every category while nothing is narrowed', () => {
    renderNav();

    expectCollapsed(labelOf('People').label);
    expectCollapsed(labelOf('Things').label);
  });

  it('caps the revealed label so a long value cannot stretch the bar', () => {
    renderNav('/memory?tags=a-very-long-tag-name-indeed,another-long-one');

    const { label } = labelOf(/^Filter by tag:/);

    expect(label).toHaveClass('max-w-[7rem]');
    expect(label).toHaveClass('text-ellipsis');
    expect(label).toHaveClass('overflow-hidden');
  });
});

describe('MemoryEntityTypeNav — dropdown values', () => {
  it('names the chosen member of a group instead of the category word', () => {
    renderNav(narrowedRoute(['Receipt']));

    const { button, label } = labelOf('Things: Receipts');

    expect(label).toHaveTextContent('Receipts');
    expectRevealed(label);
    // The chip also reads as selected, so the name is not the only signal.
    expect(button).toHaveClass('border-primary');
  });

  it('lists several chosen members of a group', () => {
    renderNav(narrowedRoute(['Product', 'Receipt']));

    expect(labelOf('Things: Products, Receipts').label).toHaveTextContent('Products, Receipts');
  });

  it('falls back to the category word when the whole group is chosen', () => {
    renderNav(narrowedRoute(['Thing', 'Product', 'Receipt']));

    const { label } = labelOf('Things');

    expect(label).toHaveTextContent('Things');
    expectRevealed(label);
  });

  it('ignores a group whose members are not what the filter narrowed to', () => {
    renderNav(narrowedRoute(['Person']));

    expectCollapsed(labelOf('Things').label);
    expectCollapsed(labelOf('Content').label);
  });

  it('shows the chosen activity kinds on the Events chip', () => {
    renderNav('/memory?eventTypes=visited,messaged');

    const { label } = labelOf('Events: visited, messaged');

    expect(label).toHaveTextContent('visited, messaged');
    expectRevealed(label);
  });

  it('shows the chosen tags on the Tag chip', () => {
    renderNav('/memory?tags=holiday');

    const { label } = labelOf('Filter by tag: holiday');

    expect(label).toHaveTextContent('holiday');
    expectRevealed(label);
  });

  it('reveals the chosen value after picking it from the dropdown', () => {
    renderNav();

    const trigger = screen.getByRole('button', { name: 'Things' });

    // Radix's DropdownMenuTrigger opens on pointerdown, not click.
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Only Products' }));

    expect(trigger).toHaveAccessibleName('Things: Products');
    expectRevealed(within(trigger).getByText('Products'));
  });
});

describe('the What strip shares its line with the filter controls without being squeezed out', () => {
  // From `xl` up the When / How / Who controls sit beside the strip. They used
  // to sit at their natural width (~1,280 px, wider than most windows), so
  // their own wrapping never engaged: at 1,400 px the strip was a 57 px sliver
  // scrolling behind them, and below ~1,350 px they dropped to a second line
  // and ran off the right edge. The controls are the flexible item now.
  it('floors the strip at 16rem from xl up and never lets it grow past its content', () => {
    const { container } = renderNav();

    const strip = container.querySelector('.overflow-x-auto');

    expect(strip).not.toBeNull();
    expect(strip).toHaveClass('flex-1', 'basis-0', 'min-w-0');
    expect(strip).toHaveClass('xl:min-w-[16rem]', 'xl:max-w-max');
    expect(strip).not.toHaveClass('md:basis-auto', 'md:min-w-[16rem]');
  });

  it('gives the filter controls their own line below xl, and a floored share of the line from xl up', () => {
    const { container } = renderNav();
    const nav = screen.getByRole('navigation', { name: 'What to show in Memory' });
    const controls = nav.lastElementChild;

    expect(nav).toHaveClass('flex-wrap');
    expect(controls).toHaveClass('basis-full', 'min-w-0', 'xl:flex-1', 'xl:basis-[24rem]');
    expect(controls).not.toHaveClass('md:basis-auto', 'md:flex-1');
    expect(container.querySelector('.w-max')).not.toBeNull();
  });
});
