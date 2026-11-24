import * as React from 'react';

import { Input } from '../ui/input';

type EmailInputProps = Omit<React.ComponentProps<typeof Input>, 'type'>;

/**
 * A text field for an email address.
 *
 * Sets what a plain `<input>` leaves to the browser's guess: on iOS the default keyboard
 * autocorrects and capitalises, which turned a typed "qa-admin@example.com" into
 * "Xanax-admin@example.com" at sign-in. `type="email"` and `inputMode="email"` bring up the
 * address keyboard, and the rest turn the keyboard assistance off. Every prop is forwarded,
 * so a caller still chooses `autoComplete` (`username` where the address is the login,
 * `email` where it is just contact data).
 *
 * Note `type="email"` also enables the browser's own constraint validation on submit, with
 * its own message. A form that shows its schema's message instead needs `noValidate`.
 */
function EmailInput(props: EmailInputProps) {
  return (
    <Input
      inputMode="email"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      {...props}
      type="email"
    />
  );
}

export { EmailInput };
