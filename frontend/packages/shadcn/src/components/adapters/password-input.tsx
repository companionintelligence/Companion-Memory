import * as React from 'react';

import { Eye, EyeOff } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Input } from '../ui/input';
import { IconButton } from './icon-button';

type PasswordInputProps = Omit<React.ComponentProps<typeof Input>, 'type'>;

/**
 * A password field with a show/hide toggle.
 *
 * Every prop is forwarded to the inner `<input>`, so the `id` / `aria-invalid` /
 * `aria-describedby` that `Form.Control` injects reach the control itself rather than the
 * positioning wrapper.
 *
 * `className` lands on the input for the same reason, which makes it the wrong place for
 * anything that sizes or hides the field: the wrapper is the box the parent lays out and
 * the box the toggle is positioned against, so `w-*` on the input detaches the toggle from
 * its right edge and `hidden` leaves the toggle behind. Size or hide the field from its
 * container instead.
 */
function PasswordInput({ className, disabled, ...props }: PasswordInputProps) {
  const [visible, setVisible] = React.useState(false);

  // Re-mask whenever the field is disabled. The toggle is disabled alongside it, so a
  // field disabled while revealed would strand the password on screen in plain text with
  // nothing left to click. Adjusted during render rather than in an effect: the masked
  // state is the one that paints, and clearing the flag (rather than only overriding
  // `type`) means re-enabling leaves the field masked instead of revealing it again.
  if (visible && disabled) {
    setVisible(false);
  }

  const label = visible ? 'Hide password' : 'Show password';

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        // Revealing makes this a text input, and browsers exempt only `type="password"`
        // from spellcheck — enhanced spellcheck would ship the revealed value to a
        // third-party service. Keyboard assistance is wrong for a password either way.
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        // Last, not first: `pr-10` is the gutter the toggle sits in and `::-ms-reveal` is
        // Edge's own reveal control that this toggle replaces — structure, not defaults a
        // caller may override. Ahead of `className`, any incoming `px-*`/`p-*` would win
        // the tailwind-merge conflict and drop the gutter, leaving the eye on the text.
        className={cn(className, 'pr-10 [&::-ms-reveal]:hidden')}
      />
      {/* The positioning lives here rather than on IconButton: when disabled, IconButton
          wraps itself in a span to keep its tooltip hoverable, which would otherwise sit
          in normal flow and add a stray line box under the field. */}
      <span className="absolute top-1/2 right-1 flex -translate-y-1/2">
        <IconButton
          label={label}
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          // Keep focus and caret in the input instead of moving them to the button.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setVisible((current) => !current)}
          className="text-muted-foreground hover:text-foreground"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </IconButton>
      </span>
    </div>
  );
}

export { PasswordInput };
export type { PasswordInputProps };
