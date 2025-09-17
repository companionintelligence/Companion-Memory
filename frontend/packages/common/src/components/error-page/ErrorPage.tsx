import { type ReactNode } from 'react';

interface Props {
  error: unknown;
  children?: ReactNode;
}

export function ErrorPage({ error, children }: Props) {
  const tryError = error as Error;
  const errorMessage = (tryError != null ? tryError.message : null) ?? 'Unknown error!';

  return (
    <div className="flex items-center justify-center absolute inset-0 z-10">
      <div>{errorMessage}</div>
      {children && <div>{children}</div>}
    </div>
  );
}
