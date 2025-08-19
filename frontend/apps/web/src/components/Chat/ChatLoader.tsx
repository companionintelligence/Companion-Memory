export function ChatLoader() {
  const className =
    'w-1.5 h-1.5 bg-muted-foreground/30 rounded-full animate-bounce transform-gpu will-change-transform';

  return (
    <div className="flex gap-2 absolute justify-center top-0.5 left-1/2 -translate-x-1/2">
      <div className={className} style={{ animationDelay: '0ms' }} />
      <div className={className} style={{ animationDelay: '150ms' }} />
      <div className={className} style={{ animationDelay: '300ms' }} />
    </div>
  );
}
