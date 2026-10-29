import type { ReactElement } from 'react';

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ThreadGridItem,
  THREAD_FRAGMENT as GRID_THREAD_FRAGMENT,
} from '@/components/entities/grid/ThreadGridItem';
import {
  ThreadResult,
  THREAD_FRAGMENT as RESULT_THREAD_FRAGMENT,
} from '@/components/SearchBox/results/ThreadResult';
import { makeFragmentData } from '@/graphql';
import { DateTimeFormatOverride } from '@/hooks/useDateTimeFormat';
import { createDateTimeFormatter } from '@/lib/dateTimeFormat';
import { renderWithProviders } from '@/test/renderWithProviders';

import { THREAD_FRAGMENT, ThreadRow } from './ThreadRow';

// A UUIDv7 minted at 2026-10-27T15:43:00Z, behind its GraphQL global id (`base64("thread:<uuid>")`),
// which is what the explorer's search results carry.
const STARTED_ID = btoa('thread:01a17e07-73a0-7abc-8def-0123456789ab');
// Pinned so the expected text does not depend on the machine's zone or its 12/24-hour habit.
const fmt = createDateTimeFormatter({ timeFormat: 'h23', timeZone: 'UTC' });
const CHAT_LABEL = 'Chat · Oct 27, 15:43';

const thread = (name: string | null, id = STARTED_ID) => ({
  __typename: 'ThreadType' as const,
  id,
  name,
  description: null,
});

const render = (ui: ReactElement) =>
  renderWithProviders(<DateTimeFormatOverride formatter={fmt}>{ui}</DateTimeFormatOverride>);

describe('untitled chat threads', () => {
  it('names an untitled thread in the explorer list as Chat does, for when it started', () => {
    render(<ThreadRow thread={makeFragmentData(thread(null), THREAD_FRAGMENT)} />);

    expect(screen.getByText(CHAT_LABEL)).toBeInTheDocument();
  });

  it('treats a blank title as untitled and keeps a real one', () => {
    const { unmount } = render(<ThreadRow thread={makeFragmentData(thread('  '), THREAD_FRAGMENT)} />);

    expect(screen.getByText(CHAT_LABEL)).toBeInTheDocument();
    unmount();

    render(<ThreadRow thread={makeFragmentData(thread('Spring cafe plans'), THREAD_FRAGMENT)} />);

    expect(screen.getByText('Spring cafe plans')).toBeInTheDocument();
    expect(screen.queryByText(CHAT_LABEL)).not.toBeInTheDocument();
  });

  it('names it the same way in the gallery and in the header search', () => {
    render(
      <>
        <ThreadGridItem thread={makeFragmentData(thread(null), GRID_THREAD_FRAGMENT)} />
        <ThreadResult thread={makeFragmentData(thread(null), RESULT_THREAD_FRAGMENT)} />
      </>,
    );

    expect(screen.getAllByText(CHAT_LABEL)).toHaveLength(2);
  });

  it('falls back to the shortened id when the id carries no start time', () => {
    render(
      <ThreadRow thread={makeFragmentData(thread(null, btoa('thread:legacy-thread-id')), THREAD_FRAGMENT)} />,
    );

    expect(screen.getByText('Thread legacy-t')).toBeInTheDocument();
  });
});
