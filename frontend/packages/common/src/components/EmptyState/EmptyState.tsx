import { type ReactNode } from 'react';

interface Props {
  icon?: ReactNode | null;
  message?: string | ReactNode;
}

export function EmptyState({ icon, message }: Props) {
  const renderedMessage = typeof message === 'string' ? <div>{message}</div> : message;

  return (
    <div className="pointer-events-none flex flex-col items-center justify-center absolute inset-0 z-10 gap-4 px-4 text-center">
      {icon}
      {renderedMessage}
    </div>
  );
}
