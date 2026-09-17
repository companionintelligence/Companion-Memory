import { Button, cn } from '@ci/shadcn';

// The Who picker's From / To toggle: `?direction=` — `inbound` (From) keeps
// messages the user received *from* a matching person, `outbound` the ones
// the user sent *to* one (To). The role is part of the match: a group chat the
// person merely belongs to does not put everyone else's messages under
// From. Without a Who pattern it is the bare row direction. A
// message-only dimension (ci.communication_direction), so setting it pins
// the browse to communications the way a place pins it to events.
export type MessageDirection = 'inbound' | 'outbound';

export const MESSAGE_DIRECTION_LABELS: Record<MessageDirection, string> = {
  inbound: 'From',
  outbound: 'To',
};

/** The URL / saved-search value as a direction, or null for anything the toggle cannot name. */
export function readMessageDirection(value: string | null | undefined): MessageDirection | null {
  return value === 'inbound' || value === 'outbound' ? value : null;
}

const CHOICES: Array<{ value: MessageDirection | null; label: string }> = [
  { value: null, label: 'Any' },
  { value: 'inbound', label: MESSAGE_DIRECTION_LABELS.inbound },
  { value: 'outbound', label: MESSAGE_DIRECTION_LABELS.outbound },
];

interface Props {
  value: MessageDirection | null;
  onChange: (next: MessageDirection | null) => void;
}

export function DirectionToggle({ value, onChange }: Props) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <span className="text-xs text-muted-foreground">Messages</span>
      <div role="group" aria-label="Message direction" className="flex gap-1">
        {CHOICES.map((choice) => {
          const pressed = choice.value === value;

          return (
            <Button
              key={choice.label}
              type="button"
              size="sm"
              variant={pressed ? 'secondary' : 'ghost'}
              aria-pressed={pressed}
              onClick={() => onChange(choice.value)}
              className={cn('h-7 px-2 text-xs', pressed && 'font-medium')}
            >
              {choice.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
