import { Button, Card, cn } from '@ci/shadcn';

import { useForage, type ForageTrial } from './useForage';

function pct(mass: number): string {
  return `${Math.round(mass * 100)}%`;
}

function BranchList({
  trial,
  disabled,
  onPin,
}: {
  trial: ForageTrial;
  disabled: boolean;
  onPin: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        Slider 1 · branch
        {trial.ready && trial.pick ? ` · committed ${trial.pick}` : ' · not ready'}
      </div>
      <div className="flex flex-col gap-1.5">
        {trial.branches.map((branch) => (
          <button
            key={branch.id}
            type="button"
            disabled={disabled || branch.past}
            onClick={() => onPin(branch.id)}
            className={cn(
              'flex items-center gap-2 rounded-sm px-1 py-0.5 text-left text-sm',
              branch.pinned && 'bg-muted',
              branch.past && 'opacity-50',
            )}
          >
            <span className="min-w-0 flex-1 truncate font-medium capitalize">{branch.id.replace(/_/g, ' ')}</span>
            <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-sm bg-muted">
              <div className="h-full bg-foreground/70" style={{ width: pct(branch.mass) }} />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
              {pct(branch.mass)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TextureList({ trial }: { trial: ForageTrial }) {
  const interests = new Map(trial.interests.map((row) => [row.person, row.activities]));

  return (
    <div>
      <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        Slider 2 · who under {trial.permutationBranch}
        {trial.texture ? ` · ${trial.texture}` : ' · still mixed'}
      </div>
      <div className="flex flex-col gap-1.5">
        {trial.permutations.map((row) => {
          const activities = interests.get(row.label) ?? [];

          return (
            <div key={row.label} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 flex-1 truncate capitalize">
                {row.label}
                {activities.length > 0 ? (
                  <span className="text-muted-foreground"> · {activities.join(', ')}</span>
                ) : null}
              </span>
              <span className="tabular-nums text-muted-foreground">{pct(row.mass)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ForagePanel() {
  const { trial, loading, busy, sample, pinBranch, resetTrial } = useForage();

  if (loading && !trial) {
    return null;
  }

  if (!trial) {
    return null;
  }

  const next = trial.attention.find((item) => !item.read);

  return (
    <Card className="lg:col-span-2" data-testid="forage-panel">
      <Card.Header>
        <Card.Title>Forager</Card.Title>
        <Card.Description>
          Discrete saccades over your memory — people, places they live, events, search indexes, and
          derived forecasts. Question: {trial.question}. Click a branch to pin it; sample reads the
          unread item with lowest G, and queries indexes again when the lake runs thin.
        </Card.Description>
      </Card.Header>
      <Card.Content className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <BranchList trial={trial} disabled={busy} onPin={(id) => pinBranch(id)} />
          <TextureList trial={trial} />
        </div>

        <div>
          <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
            Lake · ranked by G · {trial.attention.length} facts
          </div>
          <div className="flex flex-col gap-1.5">
            {trial.attention.map((item) => (
              <div
                key={item.id}
                className={cn('flex items-baseline justify-between gap-3 text-sm', item.read && 'text-muted-foreground')}
              >
                <span className="min-w-0 flex-1 truncate">
                  {item.read ? 'read' : 'unread'}
                  {item.source ? ` · ${item.source}` : ''} · {item.label}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  G {item.g.toFixed(2)} · epi {item.epistemic.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {trial.reads.length > 0 && (
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">Reads</div>
            <div className="flex flex-col gap-1 text-sm">
              {trial.reads.map((read, index) => (
                <div key={`${read.itemId}-${index}`} className="text-muted-foreground">
                  {read.itemId} → {read.cue.replace(/_/g, ' ')}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy || !next} onClick={() => sample()}>
            {next ? `Sample ${next.id.replace(/_/g, ' ')}` : 'Lake exhausted'}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => resetTrial()}>
            Rebuild lake
          </Button>
        </div>
      </Card.Content>
    </Card>
  );
}
