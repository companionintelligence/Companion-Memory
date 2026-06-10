import { useMemo } from 'react';

import { cn } from '@ci/shadcn';

interface Props {
  background: string;
  border: string;
  logo: string;
  text: string;
  disabled?: boolean;
  onClick?: () => void;
  id?: string;
  className?: string;
  subtext?: string;
  warningText?: string;
}

export function Card({
  background,
  border,
  logo,
  text,
  disabled = false,
  onClick,
  id,
  className,
  subtext,
  warningText,
}: Props) {
  const backgroundStyle = useMemo(() => {
    if (isHexColor(background)) {
      return {
        backgroundColor: background,
      };
    }

    return {};
  }, [background]);

  const borderStyle = useMemo(() => {
    if (isHexColor(border)) {
      return {
        borderColor: border,
      };
    }

    return {};
  }, [border]);

  return (
    <div
      id={id}
      className={cn(
        'text-gray-700 dark:text-gray-200 rounded-lg bg-white shadow-md dark:bg-gray-80 select-none',
        !disabled ? 'cursor-pointer' : 'opacity-50',
        className,
      )}
      onClick={!disabled ? onClick : undefined}
    >
      <div
        className={cn('flex items-center justify-center p-10 rounded-t-lg', background)}
        style={backgroundStyle}
      >
        <div
          className={cn(
            'flex items-center justify-center p-6 rounded-full bg-white aspect-square border-6',
            border,
          )}
          style={borderStyle}
        >
          <img src={logo} className="w-12 h-12" />
        </div>
      </div>
      <div className="font-semibold text-sm p-6">{text}</div>
      {warningText && (
        <div className="px-6 pb-2 text-xs text-amber-600 dark:text-amber-400">{warningText}</div>
      )}
      {subtext && <div className="font-semibold text-sm p-6">{subtext}</div>}
    </div>
  );
}

function isHexColor(color: string): boolean {
  return /^#([0-9A-F]{3}){1,2}$/i.test(color);
}
