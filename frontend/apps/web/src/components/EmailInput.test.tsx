import { EmailInput } from '@ci/shadcn';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

// On iOS an input with none of these attributes gets the default keyboard, which
// autocorrects and capitalises: "qa-admin@example.com" was typed into the login form and
// arrived as "Xanax-admin@example.com". The attributes are the fix, so they are the contract.
describe('EmailInput', () => {
  const renderField = (props: Partial<React.ComponentProps<typeof EmailInput>> = {}) => {
    render(
      <>
        <label htmlFor="em">Email</label>
        <EmailInput id="em" {...props} />
      </>,
    );

    return screen.getByLabelText('Email');
  };

  it('asks for the address keyboard and switches keyboard assistance off', () => {
    const field = renderField();

    expect(field).toHaveAttribute('type', 'email');
    expect(field).toHaveAttribute('inputmode', 'email');
    expect(field).toHaveAttribute('autocapitalize', 'none');
    expect(field).toHaveAttribute('autocorrect', 'off');
    expect(field).toHaveAttribute('spellcheck', 'false');
  });

  it('forwards the caller autoComplete and other props to the input', () => {
    const field = renderField({ autoComplete: 'username', placeholder: 'you@example.com', required: true });

    expect(field).toHaveAttribute('autocomplete', 'username');
    expect(field).toHaveAttribute('placeholder', 'you@example.com');
    expect(field).toBeRequired();
  });
});
