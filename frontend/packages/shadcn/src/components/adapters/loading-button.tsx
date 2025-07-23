import { Loader2 } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Button } from '../ui/button';

interface LoadingButtonProps extends React.ComponentProps<typeof Button> {
  loading?: boolean;
  children: React.ReactNode;
}

export function LoadingButton({ loading, children, disabled, ...props }: LoadingButtonProps) {
  return (
    <Button disabled={loading || disabled} {...props} className={cn(props.className, 'relative')}>
      {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
      {children}
    </Button>
  );
}
