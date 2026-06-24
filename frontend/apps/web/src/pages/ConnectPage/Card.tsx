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
        'overflow-hidden rounded-lg bg-white text-slate-800 shadow-md ring-1 ring-black/5 select-none dark:bg-slate-900/95 dark:text-slate-100 dark:ring-white/10',
        !disabled ? 'cursor-pointer transition hover:-translate-y-0.5 hover:shadow-lg' : 'cursor-not-allowed',
        className,
      )}
      onClick={!disabled ? onClick : undefined}
      onKeyDown={(event) => {
        if (disabled || !onClick || (event.key !== 'Enter' && event.key !== ' ')) {
          return;
        }

        event.preventDefault();
        onClick();
      }}
      role={!disabled && onClick ? 'button' : undefined}
      tabIndex={!disabled && onClick ? 0 : undefined}
      aria-disabled={disabled || undefined}
    >
      <div
        className={cn(
          'flex items-center justify-center p-10',
          disabled && 'opacity-70 saturate-75',
          background,
        )}
        style={backgroundStyle}
      >
        <div
          className={cn(
            'flex items-center justify-center p-6 rounded-full bg-white aspect-square border-6',
            border,
          )}
          style={borderStyle}
        >
          <img src={logo} className="w-12 h-12" alt="" />
        </div>
      </div>
      <div className="p-5 text-sm font-semibold leading-relaxed text-slate-800 dark:text-slate-100">
        {text}
      </div>
      {warningText && (
        <div className="px-5 pb-2 text-xs font-medium text-amber-700 dark:text-amber-300">{warningText}</div>
      )}
      {subtext && (
        <div className="px-5 pb-5 text-sm font-semibold text-slate-700 dark:text-slate-200">{subtext}</div>
      )}
    </div>
  );
}

function isHexColor(color: string): boolean {
  return /^#([0-9A-F]{3}){1,2}$/i.test(color);
}
