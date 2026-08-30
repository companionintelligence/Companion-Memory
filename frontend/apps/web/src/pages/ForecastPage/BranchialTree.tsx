import { useEffect, useMemo, useState } from 'react';

import { Button, Card, cn } from '@ci/shadcn';

import { l0Background } from '@/components/ForecastStrip/ForecastStrip';
import { CLASS_LABEL, normalizeClass } from '@/lib/activityPalette';
import { isDisplayableLabel } from '@/lib/forecastDisplay';

import {
  useBranchial,
  type BranchialBranch,
  type BranchialStep,
  type BranchialTreeData,
} from './useBranchial';

const TODAY_IDS = new Set(['night', 'morning', 'afternoon', 'evening']);

function pct(mass: number): string {
  return `${Math.round(mass * 100)}%`;
}

function stretchTitle(branch: BranchialBranch): string {
  const perm = branch.permutations.find((row) => isDisplayableLabel(row.title));
  if (perm && (branch.title === branch.l0 || !isDisplayableLabel(branch.title))) {
    return perm.title;
  }

  if (branch.title === branch.l0) {
    return CLASS_LABEL[normalizeClass(branch.l0)] ?? branch.title.toLowerCase();
  }

  return branch.title;
}

function whoLine(branch: BranchialBranch, what: string): string | null {
  const who = branch.permutations.find(
    (row) => isDisplayableLabel(row.title) && row.title !== what && !TODAY_IDS.has(row.id),
  );

  return who?.title ?? null;
}

function BranchCard({
  branch,
  selected,
  onSelect,
}: {
  branch: BranchialBranch;
  selected: boolean;
  onSelect: () => void;
}) {
  const title = stretchTitle(branch);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full rounded-md border px-2 py-1.5 text-left',
        selected ? 'border-foreground bg-muted' : 'border-transparent hover:bg-muted/60',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-sm"
          style={{ backgroundColor: l0Background(normalizeClass(branch.l0)) }}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        <span className="tabular-nums text-xs text-muted-foreground">{pct(branch.mass)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-muted">
        <div className="h-full bg-foreground/70" style={{ width: pct(branch.mass) }} />
      </div>
    </button>
  );
}

function StepColumn({
  step,
  focused,
  selectedId,
  onSelect,
}: {
  step: BranchialStep;
  focused: boolean;
  selectedId: string | null;
  onSelect: (branchId: string) => void;
}) {
  const selected = step.branches.find((branch) => branch.id === selectedId) ?? step.branches[0];

  return (
    <div
      className={cn(
        'flex w-56 shrink-0 snap-start flex-col gap-2 rounded-md border p-2',
        focused ? 'border-foreground' : 'border-border',
      )}
    >
      <div className="px-1">
        <div className="text-sm font-medium">{step.label}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {step.branches.length} {step.branches.length === 1 ? 'future' : 'futures'}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {step.branches.map((branch) => (
          <BranchCard
            key={branch.id}
            branch={branch}
            selected={branch.id === selected?.id}
            onSelect={() => onSelect(branch.id)}
          />
        ))}
      </div>
      {selected && selected.permutations.some((row) => isDisplayableLabel(row.title)) && (
        <div className="border-t pt-2">
          <div className="mb-1 px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            With {stretchTitle(selected)}
          </div>
          <div className="flex flex-col gap-1">
            {selected.permutations
              .filter((row) => isDisplayableLabel(row.title))
              .map((row) => (
                <div key={row.id} className="flex items-baseline justify-between gap-2 px-1 text-sm">
                  <span className="min-w-0 truncate">{row.title}</span>
                  <span className="tabular-nums text-muted-foreground">{pct(row.mass)}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function BranchialTreeView({ tree }: { tree: BranchialTreeData }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [path, setPath] = useState<Record<string, string>>({});

  const focused = tree.steps[Math.min(stepIndex, Math.max(tree.steps.length - 1, 0))];
  const pathTitles = useMemo(
    () =>
      tree.steps.map((step) => {
        const id = path[step.id];
        const branch = step.branches.find((row) => row.id === id) ?? step.branches[0];

        return branch ? stretchTitle(branch) : step.label;
      }),
    [path, tree.steps],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setStepIndex((index) => Math.min(index + 1, tree.steps.length - 1));
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setStepIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!focused) {
          return;
        }

        event.preventDefault();
        const current = path[focused.id] ?? focused.branches[0]?.id;
        const at = focused.branches.findIndex((branch) => branch.id === current);
        const next =
          event.key === 'ArrowDown' ? Math.min(at + 1, focused.branches.length - 1) : Math.max(at - 1, 0);
        const pick = focused.branches[next];
        if (pick) {
          setPath((prev) => ({ ...prev, [focused.id]: pick.id }));
        }
      }
    }

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [focused, path, tree.steps.length]);

  if (tree.steps.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm text-muted-foreground">Path: {pathTitles.join(' → ')}</div>
      <div className="flex gap-3 overflow-x-auto pb-2 snap-x">
        {tree.steps.map((step, index) => (
          <StepColumn
            key={step.id}
            step={step}
            focused={index === stepIndex}
            selectedId={path[step.id] ?? null}
            onSelect={(branchId) => {
              setStepIndex(index);
              setPath((prev) => ({ ...prev, [step.id]: branchId }));
            }}
          />
        ))}
      </div>
    </div>
  );
}

function NextSentences({ steps }: { steps: BranchialStep[] }) {
  const lines = steps.slice(0, 3).flatMap((step) => {
    const branch = step.branches[0];
    if (!branch) {
      return [];
    }

    const what = stretchTitle(branch);
    const who = whoLine(branch, what);
    const text = who ? `${step.label} — ${what} · ${who}` : `${step.label} — ${what}`;

    return [{ id: step.id, text, l0: branch.l0 }];
  });

  if (lines.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-col gap-2">
      {lines.map((line) => (
        <li key={line.id} className="flex items-center gap-2 text-sm">
          <span
            className="h-2 w-2 shrink-0 rounded-sm"
            style={{ backgroundColor: l0Background(normalizeClass(line.l0)) }}
          />
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function todaySteps(tree: BranchialTreeData): BranchialStep[] {
  return tree.steps.filter((step) => TODAY_IDS.has(step.id) && step.branches.length > 0);
}

export function hasCompetingFutures(steps: BranchialStep[]): boolean {
  return steps.some((step) => step.branches.length >= 2);
}

export function NextForecast() {
  const { tree, loading, guessing, guess } = useBranchial();

  if (loading && !tree) {
    return null;
  }

  const steps = tree ? todaySteps(tree) : [];
  if (!tree || steps.length === 0) {
    return null;
  }

  const competing = hasCompetingFutures(steps);
  const viewTree = { ...tree, steps };

  return (
    <Card data-testid="next-forecast">
      <Card.Header>
        <Card.Title>Next</Card.Title>
      </Card.Header>
      <Card.Content className="flex flex-col gap-3">
        {competing ? <BranchialTreeView tree={viewTree} /> : <NextSentences steps={steps} />}
        <div>
          <Button type="button" disabled={guessing} onClick={() => guess()}>
            {guessing ? 'Naming from memory…' : tree.guessed ? 'Rename from memory' : 'Name from memory'}
          </Button>
        </div>
      </Card.Content>
    </Card>
  );
}
