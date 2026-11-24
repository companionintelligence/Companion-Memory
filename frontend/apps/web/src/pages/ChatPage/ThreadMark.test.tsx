import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { paletteFor } from '@/components/PersonAvatar';
import { createDateTimeFormatter } from '@/lib/dateTimeFormat';

import { ThreadMark, threadActivity, threadMarkText } from './ThreadMark';

describe('threadMarkText', () => {
  it("uses the title's initials", () => {
    expect(threadMarkText({ name: 'Coffee with Jordan Lee', createdAt: undefined })).toBe('CW');
  });

  // Every untitled label starts "Chat · ", so initials would make them all "C".
  it('shows the day an untitled thread started', () => {
    expect(threadMarkText({ name: null, createdAt: '2026-10-23T14:09:00' })).toBe('23');
  });

  // Older appliances send no createdAt. The label reads the start time from the UUIDv7 id then,
  // and the tile has to show the same day.
  it('reads the day from a UUIDv7 id when there is no createdAt, as the label does', () => {
    const utc = createDateTimeFormatter({ timeFormat: 'h23', timeZone: 'UTC' });

    expect(
      threadMarkText({ id: '01a17e07-73a0-7abc-8def-0123456789ab', name: null, createdAt: undefined }, utc),
    ).toBe('27');
  });

  it('falls back to "?" with neither a title nor a start time', () => {
    expect(threadMarkText({ name: '  ', createdAt: undefined })).toBe('?');
  });
});

describe('threadActivity', () => {
  it('is busy while a reply is queued or running, failed when it failed, and nothing when idle', () => {
    expect(threadActivity({ generationStatus: 'queued' })).toBe('busy');
    expect(threadActivity({ generationStatus: 'running' })).toBe('busy');
    expect(threadActivity({ generationStatus: 'failed' })).toBe('failed');
    expect(threadActivity({ generationStatus: 'idle' })).toBeNull();
    expect(threadActivity({})).toBeNull();
  });
});

describe('ThreadMark', () => {
  it('colours a tile by thread id, so two chats with the same title still differ', () => {
    const ids = ['t-1', 't-2', 't-3', 't-4', 't-5', 't-6'];
    const colours = new Set(ids.map((id) => paletteFor(id).bg));

    render(
      <>
        {ids.map((id) => (
          <ThreadMark key={id} thread={{ id, name: 'openclaw conversation' }} selected={false} />
        ))}
      </>,
    );

    const tiles = screen.getAllByTestId('thread-mark');

    expect(tiles.map((tile) => tile.textContent)).toEqual(ids.map(() => 'OC'));
    expect(new Set(tiles.map((tile) => tile.style.getPropertyValue('--mark'))).size).toBe(colours.size);
    expect(colours.size).toBeGreaterThan(1);
  });

  it('draws a dot only for a busy or failed thread', () => {
    render(
      <>
        <ThreadMark thread={{ id: 'a', name: 'Idle', generationStatus: 'idle' }} selected={false} />
        <ThreadMark thread={{ id: 'b', name: 'Busy', generationStatus: 'running' }} selected={false} />
        <ThreadMark thread={{ id: 'c', name: 'Broken', generationStatus: 'failed' }} selected />
      </>,
    );

    expect(screen.getAllByTestId('thread-mark-busy')).toHaveLength(1);
    expect(screen.getAllByTestId('thread-mark-failed')).toHaveLength(1);
  });
});
