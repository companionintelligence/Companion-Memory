import { type ReactNode } from 'react';

interface Props {
  error: unknown;
  children?: ReactNode;
}

export function ErrorPage({ error, children }: Props) {
  const tryError = error as Error;
  const errorMessage = (tryError != null ? tryError.message : null) ?? 'Unknown error!';

  return (
    <div className="flex flex-col items-center justify-center absolute inset-0 z-10 gap-4">
      <div className="text-baseline">{errorMessage}</div>
      {children && <div>{children}</div>}
    </div>
  );
}
