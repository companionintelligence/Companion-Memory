import { useCallback, type ReactNode, type MouseEvent } from 'react';

import { cn } from '@ci/shadcn';

interface EntityGridItemProps {
  className?: string;
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function EntityGridItem({ className, children, onClick }: EntityGridItemProps) {
  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      onClick?.(e);
    },
    [onClick],
  );

  return (
    <div
      className={cn(
        'flex flex-col border border-border bg-card text-card-foreground shadow-md rounded-lg cursor-pointer select-none p-3 gap-3 hover:shadow-lg transition-shadow duration-75',
        className,
      )}
      onClick={handleClick}
    >
      {children}
    </div>
  );
}

interface HeaderProps {
  children: ReactNode;
}

function Header({ children }: HeaderProps) {
  return <div className="flex items-center gap-2">{children}</div>;
}

interface ContentProps {
  children: ReactNode;
  className?: string;
}

function Content({ children, className }: ContentProps) {
  return <div className={cn('flex-1 flex flex-col gap-2 min-h-0', className)}>{children}</div>;
}

interface FooterProps {
  children: ReactNode;
  className?: string;
}

function Footer({ children, className }: FooterProps) {
  return <div className={cn('flex items-center gap-2', className)}>{children}</div>;
}

EntityGridItem.Header = Header;
EntityGridItem.Content = Content;
EntityGridItem.Footer = Footer;
