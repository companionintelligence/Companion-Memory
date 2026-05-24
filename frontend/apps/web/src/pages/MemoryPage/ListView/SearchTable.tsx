import { useCallback, type ReactNode, type MouseEvent } from 'react';

import { cn } from '@ci/shadcn';

interface TableProps {
  className?: string;
  children: ReactNode;
}

export function SearchTable({ className, children }: TableProps) {
  return <div className={cn('table w-full', className)}>{children}</div>;
}

interface RowGroupProps {
  className?: string;
  children: ReactNode;
}

export function SearchRowGroup({ className, children }: RowGroupProps) {
  return <div className={cn('table-row-group', className)}>{children}</div>;
}

interface RowProps {
  className?: string;
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
}

export function SearchRow({ className, children, onClick }: RowProps) {
  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      onClick?.(e);
    },
    [onClick],
  );

  return (
    <div className={cn('table-row odd:bg-accent/20 hover:bg-accent/30', className)} onClick={handleClick}>
      {children}
    </div>
  );
}

interface CellProps {
  className?: string;
  children: ReactNode;
}

function SearchCell({ className, children }: CellProps) {
  return <div className={cn('table-cell p-1 py-2', className)}>{children}</div>;
}

SearchTable.RowGroup = SearchRowGroup;
SearchTable.Row = SearchRow;
SearchTable.Cell = SearchCell;
