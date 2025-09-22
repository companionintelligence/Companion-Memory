import type { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  primary?: boolean;
  backgroundColor?: string;
  size?: string;
}

export function Button({ label, primary = false, backgroundColor, size = 'medium', ...props }: Props) {
  const baseClasses =
    'inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50';

  const sizeClasses = {
    small: 'h-8 px-4 py-2 text-sm',
    medium: 'h-9 px-5 py-2.5 text-base',
    large: 'h-10 px-6 py-3 text-lg',
  };

  const variantClasses = primary
    ? 'bg-blue-600 text-white hover:bg-blue-700'
    : 'bg-transparent text-gray-800 border border-gray-300 hover:bg-gray-100';

  return (
    <button
      type="button"
      className={`${baseClasses} ${sizeClasses[size as keyof typeof sizeClasses]} ${variantClasses}`}
      style={backgroundColor ? { backgroundColor } : undefined}
      {...props}
    >
      {label}
    </button>
  );
}
