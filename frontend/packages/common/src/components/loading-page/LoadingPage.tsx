import { Spinner } from '@ci/shadcn';

export function LoadingPage() {
  return (
    <div className="flex items-center justify-center absolute inset-0 z-10">
      <Spinner size={48} variant="circle" color="rgb(6,108,128)" />
    </div>
  );
}
