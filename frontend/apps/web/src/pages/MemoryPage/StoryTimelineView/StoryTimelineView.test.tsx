import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntityItem } from '../useEntityService';

import { StoryTimelineView } from './StoryTimelineView';

const entity = (shape: Record<string, unknown>) => shape as unknown as EntityItem;

function eventAt(id: string, start: Date, title = id): EntityItem {
  return entity({
    __typename: 'EventType',
    id,
    bucketStartTime: start.toISOString(),
    bucketTimeSource: 'source',
    title,
    startTime: start.toISOString(),
    locationName: null,
    description: null,
    mediaContentType: null,
  });
}

const setActiveEntityMock = vi.fn();
const useEntityServiceMock = vi.fn();

vi.mock('../useEntityService', async () => {
  const actual = await vi.importActual<typeof import('../useEntityService')>('../useEntityService');

  return {
    ...actual,
    useEntityService: () => useEntityServiceMock(),
  };
});

vi.mock('@/components/TimelineJs', () => ({
  TimelineJsHost: ({
    data,
    onSlideChange,
    onSlideOpen,
    className,
  }: {
    data: { events: Array<{ unique_id: string; text: { headline: string } }> };
    onSlideChange?: (uniqueId: string) => void;
    onSlideOpen?: (uniqueId: string) => void;
    className?: string;
  }) => (
    <div data-testid="timeline-host" className={className}>
      <button type="button" onClick={() => onSlideChange?.(data.events[0]?.unique_id ?? '')}>
        land
      </button>
      <button
        type="button"
        onClick={() => onSlideChange?.(data.events[1]?.unique_id ?? data.events[0]?.unique_id ?? '')}
      >
        next
      </button>
      {data.events.map((slide) => (
        <button
          key={slide.unique_id}
          onClick={() => {
            onSlideChange?.(slide.unique_id);
            onSlideOpen?.(slide.unique_id);
          }}
        >
          {slide.text.headline}
        </button>
      ))}
    </div>
  ),
}));

function baseService(overrides: Partial<ReturnType<typeof useEntityServiceMock>[0]> = {}) {
  return [
    {
      data: [],
      loading: false,
      loadingMore: false,
      hasNextPage: false,
      totalCount: 0,
      error: undefined,
      loadMore: vi.fn(),
      refetch: vi.fn(),
      ...overrides,
    },
    { setActiveEntity: setActiveEntityMock },
  ];
}

function renderTimeline(url = '/memory/events?view=timeline') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <StoryTimelineView />
    </MemoryRouter>,
  );
}

describe('StoryTimelineView', () => {
  beforeEach(() => {
    setActiveEntityMock.mockReset();
  });

  it('uses a compact mobile timeline shell and keeps its status below the canvas', () => {
    const drill = eventAt('drill', new Date(2026, 6, 1, 10), 'Drill run');
    useEntityServiceMock.mockReturnValue(baseService({ data: [drill], totalCount: 2 }));

    renderTimeline();

    expect(screen.getByTestId('timeline-host')).toHaveClass('memory-story-timeline', 'min-h-[29rem]');
    expect(screen.getByTestId('memory-timeline')).toHaveClass('min-h-[32rem]', 'rounded-xl');
    const mobileGuidance = screen.getByText('Swipe or use arrows · tap an event to open');
    expect(mobileGuidance).toHaveClass('device:hidden');
    expect(mobileGuidance.parentElement).toHaveClass('border-t', 'device:absolute');
    expect(screen.getByText('1 of 1 loaded · end')).toBeInTheDocument();
  });

  it('does not open the detail drawer on TimelineJS landing change', () => {
    const drill = eventAt('drill', new Date(2026, 6, 1, 10), 'Drill run');
    useEntityServiceMock.mockReturnValue(baseService({ data: [drill] }));

    renderTimeline();
    fireEvent.click(screen.getByRole('button', { name: 'land' }));

    expect(setActiveEntityMock).not.toHaveBeenCalled();
  });

  it('does not open the detail drawer when navigating to the next slide', () => {
    const drill = eventAt('drill', new Date(2026, 6, 1, 10), 'Drill run');
    const lamp = eventAt('lamp', new Date(2026, 6, 2, 10), 'Desk lamp');
    useEntityServiceMock.mockReturnValue(baseService({ data: [drill, lamp] }));

    renderTimeline();
    fireEvent.click(screen.getByRole('button', { name: 'land' }));
    fireEvent.click(screen.getByRole('button', { name: 'next' }));

    expect(setActiveEntityMock).not.toHaveBeenCalled();
  });

  it('sets the active entity to the clicked slide, so it opens the shared detail drawer', () => {
    const drill = eventAt('drill', new Date(2026, 6, 1, 10), 'Drill run');
    const lamp = eventAt('lamp', new Date(2026, 6, 2, 10), 'Desk lamp');
    useEntityServiceMock.mockReturnValue(baseService({ data: [drill, lamp] }));

    renderTimeline();
    fireEvent.click(screen.getByRole('button', { name: 'land' }));
    fireEvent.click(screen.getByText('Desk lamp'));

    expect(setActiveEntityMock).toHaveBeenCalledWith(lamp);
  });

  it('opens the drawer from a tap on the current slide', () => {
    const drill = eventAt('drill', new Date(2026, 6, 1, 10), 'Drill run');
    useEntityServiceMock.mockReturnValue(baseService({ data: [drill] }));

    renderTimeline();
    fireEvent.click(screen.getByText('Drill run'));

    expect(setActiveEntityMock).toHaveBeenCalledWith(drill);
  });

  it('shows how many dated slides are loaded, not just the ones that fit the window', () => {
    const flood = Array.from({ length: 80 }, (_, index) =>
      eventAt(`e-${index}`, new Date(2026, 5, 1 + index, 10), `Item ${index}`),
    );
    useEntityServiceMock.mockReturnValue(baseService({ data: flood }));

    renderTimeline();

    // 80 dated rows are in hand but the deck only ever mounts a window of
    // MEMORY_TIMELINE_MAX_SLIDES (48) — the count must say so, not go silent.
    expect(screen.getByText('48 of 80 loaded · end')).toBeInTheDocument();
  });

  it('shows the timeline, not an endless skeleton, when a later search page fails', () => {
    const drill = eventAt('drill', new Date(2026, 6, 1, 10), 'Drill run');
    const lamp = eventAt('lamp', new Date(2026, 6, 2, 10), 'Desk lamp');
    useEntityServiceMock.mockReturnValue(
      baseService({
        data: [drill, lamp],
        hasNextPage: true,
        error: new Error('network'),
      }),
    );

    renderTimeline();

    expect(screen.getByTestId('memory-timeline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('shows ErrorState when the search fails with nothing to put on the axis', () => {
    useEntityServiceMock.mockReturnValue(
      baseService({
        data: [],
        hasNextPage: true,
        error: new Error('network'),
      }),
    );

    renderTimeline();

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
