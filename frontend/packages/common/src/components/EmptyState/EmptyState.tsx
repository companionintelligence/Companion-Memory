import { type ReactNode } from 'react';

interface Props {
  icon?: ReactNode | null;
  message?: string | ReactNode;
}

export function EmptyState({ icon, message }: Props) {
  const renderedMessage = typeof message === 'string' ? <div>{message}</div> : message;

  return (
    /*
     * Both halves of the pointer-events pair are load-bearing. The outer
     * element is an absolutely-positioned overlay across the whole list area,
     * so it stays `none` and its empty regions keep letting clicks through to
     * whatever is underneath. But callers pass buttons and links as the
     * message (NotesPage's "Create note", SavedSearchesPage's two CTAs), and
     * those inherited `none` and were dead — so the content wrapper turns
     * events back on for the actual content box. Dropping either half
     * reintroduces one of the two bugs.
     *
     * Inline styles rather than Tailwind utilities: this package is not in the
     * web app's Tailwind source set (`frontend/apps/web/src/styles/index.css`
     * lists `packages/{capture,editor,shadcn}` only), so a class authored here
     * and nowhere else is never compiled into the bundle — which is exactly
     * how the earlier `[&>*]:pointer-events-auto` attempt at this silently did
     * nothing. Inline styles are immune to the content globs of every app that
     * consumes this shared package.
     */
    <div
      style={{ pointerEvents: 'none' }}
      className="flex flex-col items-center justify-center absolute inset-0 z-10 px-4 text-center"
    >
      <div style={{ pointerEvents: 'auto' }} className="flex flex-col items-center gap-4">
        {icon}
        {renderedMessage}
      </div>
    </div>
  );
}
