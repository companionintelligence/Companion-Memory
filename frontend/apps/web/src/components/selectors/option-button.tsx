import { cn } from '@ci/shadcn';

interface Props {
  selected: boolean;
  label: string;
  description?: string;
  imageUrl?: string;
  onClick: () => void;
}

export function OptionButton({ selected, label, description, imageUrl, onClick }: Props) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'rounded-md border px-3 py-2 text-left text-sm transition-colors',
        selected
          ? 'border-primary bg-primary/10 text-foreground'
          : 'border-border bg-background hover:bg-accent',
      )}
    >
      {imageUrl ? <img src={imageUrl} alt="" className="mb-2 h-16 w-full rounded object-cover" /> : null}
      <span className="font-medium">{label}</span>
      {description ? <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span> : null}
    </button>
  );
}
