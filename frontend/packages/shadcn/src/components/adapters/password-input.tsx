import * as React from 'react';

import { Eye, EyeOff } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Input } from '../ui/input';
import { IconButton } from './icon-button';

interface PasswordInputProps extends Omit<React.ComponentProps<typeof Input>, 'type'> {
  /** Classes for the positioning wrapper. `className` still lands on the input itself. */
  containerClassName?: string;
}

/**
 * A password field with a show/hide toggle.
 *
 * Every prop other than `containerClassName` is forwarded to the inner `<input>`, so the
 * `id` / `aria-invalid` / `aria-describedby` that `Form.Control` injects reach the control
 * itself rather than the positioning wrapper.
 */
function PasswordInput({ className, containerClassName, disabled, ...props }: PasswordInputProps) {
  const [visible, setVisible] = React.useState(false);
  const label = visible ? 'Hide password' : 'Show password';

  return (
    <div className={cn('relative', containerClassName)}>
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        // `::-ms-reveal` is Edge's own reveal control, which this toggle replaces.
        className={cn('pr-10 [&::-ms-reveal]:hidden', className)}
      />
      <IconButton
        label={label}
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={disabled}
        // Keep focus and caret in the input instead of moving them to the button.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setVisible((current) => !current)}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1 -translate-y-1/2"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </IconButton>
    </div>
  );
}

export { PasswordInput };
export type { PasswordInputProps };
