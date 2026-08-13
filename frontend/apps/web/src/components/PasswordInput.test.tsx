import { createRef } from 'react';

import { PasswordInput } from '@ci/shadcn';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// PasswordInput wraps the shared Input in a positioning div so the reveal toggle can sit
// inside the field. That wrapper is the risk: anything a form injects into the component
// has to keep reaching the real <input>, not the div. These tests pin that contract along
// with the toggle behaviour itself.
describe('PasswordInput', () => {
  const getField = () => screen.getByLabelText('Password', { selector: 'input' });

  function renderField(props: Partial<React.ComponentProps<typeof PasswordInput>> = {}) {
    return render(
      <>
        <label htmlFor="pw">Password</label>
        <PasswordInput id="pw" {...props} />
      </>,
    );
  }

  it('masks the value until the toggle is pressed', () => {
    renderField();

    expect(getField()).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(getField()).toHaveAttribute('type', 'text');

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(getField()).toHaveAttribute('type', 'password');
  });

  it('keeps what the user typed when visibility flips', () => {
    renderField();

    fireEvent.change(getField(), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(getField()).toHaveValue('hunter2');
  });

  it('leaves the label pointing at exactly one control', () => {
    // The toggle's accessible name also contains "password", so a careless implementation
    // makes label lookups ambiguous and breaks every consumer's tests.
    renderField();

    expect(screen.getAllByLabelText('Password', { selector: 'input' })).toHaveLength(1);
  });

  it('forwards form-injected props to the input rather than the wrapper', () => {
    // Form.Control is a Radix Slot that clones its child with id, aria-invalid and
    // aria-describedby. Those have to land on the control for the label association and
    // the error wiring to survive.
    renderField({ 'aria-invalid': true, 'aria-describedby': 'pw-message' });

    const field = getField();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', 'pw-message');
    expect(field.parentElement).not.toHaveAttribute('aria-invalid');
  });

  it('attaches a ref to the input element', () => {
    // react-hook-form registers the field through this ref; without it validation and
    // focus-on-error silently stop working.
    const ref = createRef<HTMLInputElement>();
    renderField({ ref });

    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current).toBe(getField());
  });

  it('does not submit the surrounding form when toggled', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <label htmlFor="pw">Password</label>
        <PasswordInput id="pw" />
      </form>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables the toggle alongside the field', () => {
    renderField({ disabled: true });

    expect(getField()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
  });
});
