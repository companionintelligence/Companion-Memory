import { fireEvent, render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntityItem } from '../useEntityService';

const mocks = vi.hoisted(() => ({
  useEntityService: vi.fn(),
  groupEntitiesByBucket: vi.fn(),
  isChronologicalSort: vi.fn(),
  observerCallback: undefined as IntersectionObserverCallback | undefined,
}));

vi.mock('../../MemoryPage/useEntityService', () => ({
  useEntityService: mocks.useEntityService,
}));

vi.mock('@/components/ChatWithAgent', () => ({
  MemoryChatAbout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/utils', () => ({ formatEnumLabel: (value: string) => value.toUpperCase() }));

vi.mock('../Components', () => ({
  DateGroupHeader: ({ label, count }: { label: string; count: number }) => (
    <h3>{label} ({count})</h3>
  ),
  Empty: ({ title, description }: { title: string; description: string }) => (
    <div role="status">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  ),
  EntityCard: ({ entity }: { entity: EntityItem }) => (
    <button type="button" data-testid={`entity-${entity.id}`}>
      {(entity as { title?: string }).title ?? entity.id}
    </button>
  ),
  ErrorState: ({ onRetry }: { onRetry: () => void }) => (
    <div role="alert">
      <button type="button" onClick={onRetry}>Try again</button>
    </div>
  ),
  TimelineSkeleton: ({ count, className }: { count: number; className?: string }) => (
    <div data-testid="timeline-skeleton" data-count={count} className={className} />
  ),
  groupEntitiesByBucket: mocks.groupEntitiesByBucket,
  isChronologicalSort: mocks.isChronologicalSort,
}));

import { TimelineView } from './TimelineView';

const entity = (shape: Record<string, unknown>) => shape as unknown as EntityItem;

function event(id: string, eventType: string, title = id): EntityItem {
  return entity({ __typename: 'EventType', id, eventType, title });
}

function baseService(overrides: Record<string, unknown> = {}) {
  return [
    {
      data: [],
      loading: false,
      loadingMore: false,
      hasNextPage: false,
      error: undefined,
      loadMore: vi.fn(),
      refetch: vi.fn(),
      ...overrides,
    },
    {},
  ];
}

function renderTimeline(url = '/memory?sortBy=relevance', props: React.ComponentProps<typeof TimelineView> = {}) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <TimelineView {...props} />
    </MemoryRouter>,
  );
}

describe('TimelineView', () => {
  beforeEach(() => {
    mocks.groupEntitiesByBucket.mockReset();
    mocks.groupEntitiesByBucket.mockImplementation((entities: EntityItem[]) =>
      entities.length ? [{ key: 'today', label: 'Today', entities }] : [],
    );
    mocks.isChronologicalSort.mockImplementation((sortBy: string | null, hasSearch: boolean) =>
      !hasSearch && (sortBy === 'newest' || sortBy === 'oldest'),
    );
    mocks.observerCallback = undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          mocks.observerCallback = callback;
        }

        observe = vi.fn();

        disconnect = vi.fn();
      },
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('shows the first-page skeleton while loading without results', () => {
    mocks.useEntityService.mockReturnValue(baseService({ loading: true }));

    renderTimeline();

    expect(screen.getByTestId('timeline-skeleton')).toHaveAttribute('data-count', '5');
  });

  it('shows a retry state when the first page fails', () => {
    const refetch = vi.fn();
    mocks.useEntityService.mockReturnValue(
      baseService({ error: new Error('offline'), hasNextPage: true, refetch }),
    );

    renderTimeline();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('keeps the map side panel blank when there are no timeline rows', () => {
    mocks.useEntityService.mockReturnValue(baseService());

    const { container } = renderTimeline('/memory?view=map');

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a distinct empty state for an unfiltered memory', () => {
    mocks.useEntityService.mockReturnValue(baseService());

    renderTimeline();

    expect(screen.getByRole('status')).toHaveTextContent('No memories yet');
  });

  it('explains when active filters return no memories', () => {
    mocks.useEntityService.mockReturnValue(baseService());

    renderTimeline('/memory?search=unicorn');

    expect(screen.getByRole('status')).toHaveTextContent('No memories match these filters');
  });

  it('distinguishes results that have no time-based card types', () => {
    mocks.useEntityService.mockReturnValue(
      baseService({ data: [entity({ __typename: 'PersonType', id: 'person-1' })] }),
    );

    renderTimeline();

    expect(screen.getByRole('status')).toHaveTextContent('No timeline events match this search');
  });

  it('groups chronological rows, filters unsupported types, and wires row selection and hover', () => {
    const first = event('first', 'visited', 'First visit');
    const second = event('second', 'messaged', 'Sent message');
    const unsupported = entity({ __typename: 'PersonType', id: 'person-1', title: 'Person' });
    const loadMore = vi.fn();
    const registerTimelineRow = vi.fn();
    const onEntitySelect = vi.fn();
    const onEntityHover = vi.fn();
    mocks.useEntityService.mockReturnValue(
      baseService({ data: [first, unsupported, second], hasNextPage: true, loadingMore: true, loadMore }),
    );

    const { unmount } = renderTimeline('/memory?sortBy=newest', {
      activeEntityId: 'first',
      onEntitySelect,
      onEntityHover,
      registerTimelineRow,
    });

    expect(mocks.groupEntitiesByBucket).toHaveBeenCalledWith([first, second]);
    expect(screen.getByRole('heading', { name: 'Today (2)' })).toBeInTheDocument();
    expect(screen.getByTestId('entity-first')).toBeInTheDocument();
    expect(screen.queryByTestId('entity-person-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('timeline-skeleton')).toHaveAttribute('data-count', '2');
    expect(registerTimelineRow).toHaveBeenCalledWith('first', expect.any(HTMLDivElement));
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'nearest',
    });

    fireEvent.click(screen.getByTestId('entity-first'));
    fireEvent.mouseEnter(screen.getByTestId('entity-first').parentElement!);
    fireEvent.mouseLeave(screen.getByTestId('entity-first').parentElement!);
    expect(onEntitySelect).toHaveBeenCalledWith(first);
    expect(onEntityHover).toHaveBeenNthCalledWith(1, first);
    expect(onEntityHover).toHaveBeenNthCalledWith(2, null);

    act(() => {
      mocks.observerCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(loadMore).toHaveBeenCalledOnce();

    unmount();
    expect(registerTimelineRow).toHaveBeenCalledWith('first', null);
  });

  it('groups events by activity type with the busiest section first', () => {
    const events = [
      entity({ __typename: 'BrowserActivityType', id: 'browser' }),
      entity({ __typename: 'EventType', id: 'untagged' }),
      event('a', 'visited'),
      event('b', 'visited'),
      event('c', 'messaged'),
    ];
    mocks.useEntityService.mockReturnValue(baseService({ data: events }));

    renderTimeline('/memory?view=events', { groupByEventType: true });

    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings).toEqual(['OTHER (2)', 'VISITED (2)', 'MESSAGED (1)']);
    expect(mocks.groupEntitiesByBucket).not.toHaveBeenCalled();
  });

  it('loads the next page only when the sentinel intersects the viewport', () => {
    const loadMore = vi.fn();
    mocks.useEntityService.mockReturnValue(
      baseService({ data: [event('a', 'visited')], hasNextPage: true, loadMore }),
    );

    const { unmount } = renderTimeline();

    act(() => {
      mocks.observerCallback?.([], {} as IntersectionObserver);
      mocks.observerCallback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(loadMore).not.toHaveBeenCalled();

    act(() => {
      mocks.observerCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(loadMore).toHaveBeenCalledOnce();

    unmount();
  });

  it('does not apply date grouping to search results even when the sort is chronological', () => {
    mocks.useEntityService.mockReturnValue(baseService({ data: [event('a', 'visited')] }));
    mocks.isChronologicalSort.mockReturnValue(false);

    renderTimeline('/memory?sortBy=newest&search=visit');

    expect(mocks.groupEntitiesByBucket).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: /Today/ })).not.toBeInTheDocument();
  });
});
