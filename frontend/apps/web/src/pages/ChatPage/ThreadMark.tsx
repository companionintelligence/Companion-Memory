import type { CSSProperties } from 'react';

import { cn } from '@ci/shadcn';

import { initialsFor, paletteFor } from '@/components/PersonAvatar';
import { DEVICE_DATE_TIME_FORMATTER, type DateTimeFormatter } from '@/lib/dateTimeFormat';

import type { Thread } from './types';
import { threadInstant } from './useRecentThreads';

/**
 * What a thread's tile says.
 *
 * A titled thread shows its title's initials, the same way a person without a
 * photo shows theirs. An untitled one is named for when it started (see
 * `threadLabel`), so its tile shows that day of the month rather than the "C"
 * every "Chat · …" label would give.
 */
export function threadMarkText(
  thread: Pick<Thread, 'name' | 'createdAt'>,
  fmt: DateTimeFormatter = DEVICE_DATE_TIME_FORMATTER,
): string {
  const name = thread.name?.trim();

  if (name) {
    return initialsFor(name);
  }

  const started = threadInstant(thread.createdAt);

  if (started) {
    return fmt.dateTime(started, { day: 'numeric' });
  }

  return '?';
}

/** Whether a reply is being written, or the last one failed: the only states worth a dot. */
export function threadActivity(thread: Pick<Thread, 'generationStatus'>): 'busy' | 'failed' | null {
  if (thread.generationStatus === 'running' || thread.generationStatus === 'queued') {
    return 'busy';
  }

  return thread.generationStatus === 'failed' ? 'failed' : null;
}

interface ThreadMarkProps {
  thread: Pick<Thread, 'id' | 'name' | 'createdAt' | 'generationStatus'>;
  selected: boolean;
  size?: 'sm' | 'md';
  fmt?: DateTimeFormatter;
}

/**
 * A thread's tile in the chat sidebar, collapsed or open.
 *
 * Square-cornered, so it never reads as a person: people are the round
 * `PersonAvatar`, and a chat about Jordan Lee shows "JL" too. The colour comes
 * from `PersonAvatar`'s checked palette, seeded by the thread's id rather than
 * its title, so two chats with the same title still look different and a tile
 * keeps its colour when a late title arrives. Unselected tiles are a tint of
 * that colour; the open thread is the solid colour, with white text, which is
 * the pair the palette was contrast-checked for.
 *
 * The dot is drawn only when it means something: a reply being written, or one
 * that failed. It used to sit on every row, grey unless the row was selected,
 * which said nothing the row's own highlight didn't.
 */
export function ThreadMark({
  thread,
  selected,
  size = 'md',
  fmt = DEVICE_DATE_TIME_FORMATTER,
}: ThreadMarkProps) {
  const { bg } = paletteFor(thread.id);
  const activity = threadActivity(thread);

  return (
    <span
      aria-hidden="true"
      data-testid="thread-mark"
      style={{ '--mark': bg } as CSSProperties}
      className={cn(
        'relative inline-flex shrink-0 select-none items-center justify-center rounded-lg font-semibold leading-none tabular-nums transition-colors duration-200',
        size === 'md' ? 'size-10 text-sm' : 'size-8 text-xs',
        selected
          ? 'bg-[var(--mark)] text-white shadow-sm'
          : 'bg-[color-mix(in_oklab,var(--mark)_12%,transparent)] text-[color-mix(in_oklab,var(--mark)_80%,black)] dark:bg-[color-mix(in_oklab,var(--mark)_32%,transparent)] dark:text-[color-mix(in_oklab,var(--mark)_30%,white)]',
      )}
    >
      {threadMarkText(thread, fmt)}
      {activity ? (
        <span
          data-testid={`thread-mark-${activity}`}
          className={cn(
            'absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-background',
            activity === 'busy' ? 'animate-pulse bg-primary motion-reduce:animate-none' : 'bg-destructive',
          )}
        />
      ) : null}
    </span>
  );
}
