import { createRef } from 'react';

import { Form, PasswordInput, useForm } from '@ci/shadcn';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// PasswordInput wraps the shared Input in a positioning div so the reveal toggle can sit
// inside the field. That wrapper is the risk: anything a form injects into the component
// has to keep reaching the real <input>, not the div. These tests pin that contract along
// with the toggle behaviour itself.
describe('PasswordInput', () => {
  const getField = () => screen.getByLabelText('Password', { selector: 'input' });

  const labelledField = (props: Partial<React.ComponentProps<typeof PasswordInput>> = {}) => (
    <>
      <label htmlFor="pw">Password</label>
      <PasswordInput id="pw" {...props} />
    </>
  );

  function renderField(props: Partial<React.ComponentProps<typeof PasswordInput>> = {}) {
    return render(labelledField(props));
  }

  it('masks the value until the toggle is pressed', () => {
    renderField();

    expect(getField()).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(getField()).toHaveAttribute('type', 'text');

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(getField()).toHaveAttribute('type', 'password');
  });

  it('keeps browser text assistance off in both states', () => {
    // Revealing makes this a text input, and browsers exempt only type=password from
    // spellcheck — enhanced spellcheck would ship the revealed value to a third party.
    renderField();

    expect(getField()).toHaveAttribute('spellcheck', 'false');
    expect(getField()).toHaveAttribute('autocapitalize', 'off');
    expect(getField()).toHaveAttribute('autocorrect', 'off');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(getField()).toHaveAttribute('type', 'text');
    expect(getField()).toHaveAttribute('spellcheck', 'false');
  });

  it('keeps what the user typed when visibility flips', () => {
    renderField();

    fireEvent.change(getField(), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(getField()).toHaveValue('hunter2');
  });

  it('leaves the label pointing at exactly one control', () => {
    // The toggle's accessible name also contains "password", so naming it carelessly
    // makes label lookups ambiguous and breaks every consumer's tests. Queried without a
    // selector on purpose — restricting to `input` would exclude the button and so could
    // never see the ambiguity this guards against.
    renderField();

    expect(screen.getAllByLabelText('Password')).toHaveLength(1);
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

  it('carries Form.Control through the Slot to the input', () => {
    // The test above injects those props directly, which never exercises the Radix Slot
    // clone that puts them there in real use. This renders the actual Form stack, so a
    // change that breaks the clone (an added Fragment, a wrapper that swallows props)
    // fails here rather than only in the browser.
    function Harness() {
      const form = useForm<{ password: string }>({ defaultValues: { password: '' } });

      return (
        <Form {...form}>
          <Form.Field
            control={form.control}
            name="password"
            render={({ field }) => (
              <Form.Item>
                <Form.Label>Password</Form.Label>
                <Form.Control>
                  <PasswordInput {...field} autoComplete="current-password" />
                </Form.Control>
                <Form.Message />
              </Form.Item>
            )}
          />
        </Form>
      );
    }

    // Queried through the render result rather than `screen`, so this reads only the tree
    // it just mounted and can never match a stray field left elsewhere in the document.
    const { getByLabelText } = render(<Harness />);
    const field = getByLabelText('Password', { selector: 'input' });

    expect(field.id).toBeTruthy();
    expect(field).toHaveAttribute('name', 'password');
    expect(field).toHaveAttribute('aria-invalid', 'false');
    // Exact, not `stringContaining(field.id)`: the description id is the field id plus a
    // suffix, so a containment check also passes for a self-referential describedby —
    // i.e. for a FormControl that has stopped pointing at the description at all.
    expect(field).toHaveAttribute('aria-describedby', `${field.id}-description`);
    expect(field).toHaveAttribute('autocomplete', 'current-password');

    // The positioning wrapper is layout and nothing else — every injected prop went past
    // it. Asserted prop by prop rather than as an exact attribute list: the list would
    // also pin where unrelated `data-slot` markers happen to land.
    const wrapper = field.parentElement;
    expect(wrapper).toHaveClass('relative');
    expect(wrapper).not.toHaveAttribute('id');
    expect(wrapper).not.toHaveAttribute('name');
    expect(wrapper).not.toHaveAttribute('aria-invalid');
    expect(wrapper).not.toHaveAttribute('aria-describedby');
    expect(wrapper).not.toHaveAttribute('autocomplete');
  });

  it('keeps the toggle gutter when the caller brings its own padding', () => {
    // `pr-10` is the space the toggle sits in, not a default. Merged ahead of the
    // caller's classes it loses the tailwind-merge conflict to any `px-*`/`p-*` and the
    // eye lands on top of the typed characters.
    renderField({ className: 'px-2' });

    expect(getField()).toHaveClass('pr-10');
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

  it('does not take focus off the field when the toggle is pressed', () => {
    // Focus and caret stay put because the toggle cancels mousedown. fireEvent.click
    // never dispatches mousedown, so every other test here passes with that handler
    // deleted; this one dispatches it and reads back whether it was cancelled.
    renderField();

    const cancelled = !fireEvent.mouseDown(screen.getByRole('button', { name: 'Show password' }));
    expect(cancelled).toBe(true);
  });

  it('disables the toggle alongside the field', () => {
    renderField({ disabled: true });

    expect(getField()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
  });

  it('re-masks a revealed field when it becomes disabled', () => {
    // The toggle goes disabled with the field, so a reveal that outlived being disabled
    // would leave the password sitting in plain text with nothing left to click.
    const { rerender } = renderField();

    fireEvent.change(getField(), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(getField()).toHaveAttribute('type', 'text');

    rerender(labelledField({ disabled: true }));
    expect(getField()).toHaveAttribute('type', 'password');

    // And re-enabling must not hand the reveal back without the user asking again.
    rerender(labelledField());
    expect(getField()).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument();
  });

  it('keeps the toggle out of normal flow even when disabled', () => {
    // A disabled IconButton wraps itself in a span so its tooltip stays hoverable. That
    // span must stay inside the absolutely-positioned wrapper, or it sits in flow and
    // adds a stray line box under the field — a layout break jsdom cannot measure, so
    // this asserts the containment that prevents it.
    renderField({ disabled: true });

    const positioner = screen.getByRole('button', { name: 'Show password' }).closest('span.absolute');
    expect(positioner).not.toBeNull();
    expect(positioner?.parentElement).toBe(getField().parentElement);
  });
});
