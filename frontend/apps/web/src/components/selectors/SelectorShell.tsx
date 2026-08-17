import type { KeyboardEvent, ReactNode } from 'react';

import { Button } from '@ci/shadcn';

interface Props {
  prompt: string;
  hint?: string;
  children: ReactNode;
  canSubmit: boolean;
  submitting?: boolean;
  hideSave?: boolean;
  onSubmit: () => void;
  onSkip: () => void;
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.tagName === 'TEXTAREA' ||
    (target.tagName === 'INPUT' && target.getAttribute('type') !== 'checkbox')
  );
}

export function SelectorShell({
  prompt,
  hint,
  children,
  canSubmit,
  submitting,
  hideSave,
  onSubmit,
  onSkip,
}: Props) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      !isTextField(event.target)
    ) {
      return;
    }

    event.preventDefault();
    if (canSubmit && !submitting) {
      onSubmit();
    }
  };

  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <div>
        <p className="text-sm font-medium text-foreground">{prompt}</p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {hideSave ? (
        <div className="flex flex-wrap items-center gap-2">
          {children}
          <Button size="sm" variant="ghost" disabled={submitting} onClick={onSkip}>
            Skip
          </Button>
        </div>
      ) : (
        <>
          {children}
          <div className="flex gap-2">
            <Button size="sm" disabled={!canSubmit || submitting} onClick={onSubmit}>
              Save
            </Button>
            <Button size="sm" variant="ghost" disabled={submitting} onClick={onSkip}>
              Skip
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
