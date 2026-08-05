import * as React from 'react';

import { cn } from '../../lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // Fill with --input-fill, not --input: the latter is the *border* token, so on
        // dark themes it is a light colour and painting it opaque here left the typed
        // text at ~1.2:1 against --foreground (invisible). Kept as one utility rather
        // than a base + `dark:` pair so a caller's own `bg-*` override collapses it
        // cleanly in tailwind-merge instead of leaving the dark variant behind.
        'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-input flex h-9 w-full min-w-0 rounded-md border bg-input-fill px-3 py-1 text-sm leading-5 shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
