import type { ReactNode } from 'react';

import { SOURCE_PATH_INFO, type SourcePath } from './SourcePathTiles';

/**
 * What this path is, at the top of the path's own content.
 *
 * Every one of the three opens the same way — name, what it costs you, what you
 * get — so moving between them changes the answers and not the shape. It
 * replaced a per-section standfirst that said something different in each
 * place, and the `Effort`/`You get` pair that used to sit on the switch above
 * and make three tiles three different heights.
 *
 * `actions` is the path's own controls, aligned right on the heading row —
 * Import puts Inbox and History there. They belong level with the name of the
 * path they belong to rather than a row further down, where they sat at the
 * end of a step sequence they are not a step of.
 */
export function PathHeader({ path, actions }: { path: SourcePath; actions?: ReactNode }) {
  const info = SOURCE_PATH_INFO[path];

  return (
    <header className="mb-6 flex w-full flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="mb-2 text-2xl font-bold">{info.title}</h2>

        <dl className="text-sm">
          <div className="flex gap-2">
            <dt className="text-muted-foreground w-20 shrink-0">Effort</dt>
            <dd>{info.effort}</dd>
          </div>
          <div className="mt-1 flex gap-2">
            <dt className="text-muted-foreground w-20 shrink-0">You get</dt>
            <dd>{info.gets}</dd>
          </div>
        </dl>
      </div>

      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
  );
}
