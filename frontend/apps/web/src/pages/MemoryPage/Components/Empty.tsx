import { cn } from '@ci/shadcn';
import type { LucideIcon } from '@ci/shadcn/icons';

interface EmptyProps {
  title: string;
  description?: string;
  icon?: LucideIcon | string;
  className?: string;
}

export function Empty({ title, description, icon: Icon, className }: EmptyProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center px-6 py-12', className)}>
      {title && <h3 className="text-lg font-medium text-foreground mb-2">{title}</h3>}

      {description && <p className="text-muted-foreground mb-4">{description}</p>}

      {Icon && (
        <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center">
          {typeof Icon === 'string' ? (
            <span className="text-2xl">{Icon}</span>
          ) : (
            <Icon className="h-8 w-8 text-muted-foreground" />
          )}
        </div>
      )}
    </div>
  );
}
