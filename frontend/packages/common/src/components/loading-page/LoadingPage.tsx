import { Spinner } from '@ci/shadcn';

interface Props {
  message?: string;
}

export function LoadingPage({ message }: Props) {
  return (
    <div className="flex flex-col items-center justify-center absolute inset-0 z-10 gap-4">
      <Spinner size={48} variant="circle" color="rgb(6,108,128)" />

      {message && <div>{message}</div>}
    </div>
  );
}
