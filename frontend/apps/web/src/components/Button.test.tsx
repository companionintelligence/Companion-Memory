import { Button } from '@ci/shadcn';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Behavior/smoke coverage for the shadcn Button primitive — the most widely used
// styled component in the web app and the one carrying the canonical design-system
// surface class on its default variant (see PR #1644 token normalization).
describe('Button (shadcn primitive)', () => {
  it('renders its label and is a real <button>', () => {
    render(<Button>Save</Button>);

    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toBeInTheDocument();
    expect(button.tagName).toBe('BUTTON');
    // data-slot is the shadcn contract other components/selectors rely on.
    expect(button).toHaveAttribute('data-slot', 'button');
  });

  it('fires onClick when pressed', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);

    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick when disabled', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Nope
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Nope' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('default variant carries the canonical CI primary surface class', () => {
    render(<Button>Primary</Button>);

    // The canonical design system re-keyed the default button to the shared
    // `ci-primary-surface` token utility (teal --primary) rather than an ad-hoc
    // bg-primary. Guard that contract so a variant refactor can't silently drop it.
    expect(screen.getByRole('button', { name: 'Primary' })).toHaveClass('ci-primary-surface');
  });

  it('applies the requested variant/size and merges custom classes', () => {
    render(
      <Button variant="secondary" size="lg" className="w-full">
        Wide
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Wide' });
    expect(button).toHaveClass('bg-secondary');
    expect(button).toHaveClass('w-full');
  });

  it('renders as a child element when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/memory">Open memory</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Open memory' });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/memory');
    // asChild forwards the button styling/contract onto the anchor.
    expect(link).toHaveAttribute('data-slot', 'button');
  });
});
