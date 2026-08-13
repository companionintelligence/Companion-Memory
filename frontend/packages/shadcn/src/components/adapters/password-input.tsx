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
 */
function PasswordInput({ className, disabled, ...props }: PasswordInputProps) {
  const [visible, setVisible] = React.useState(false);
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
        // `::-ms-reveal` is Edge's own reveal control, which this toggle replaces.
        className={cn('pr-10 [&::-ms-reveal]:hidden', className)}
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
