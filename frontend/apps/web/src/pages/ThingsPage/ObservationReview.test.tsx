import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { GetUnresolvedObservationsQuery } from '@/graphql/graphql';
import { mockQuery } from '@/test/gql';
import { renderWithProviders } from '@/test/renderWithProviders';

import {
  CONFIRM_OBSERVATION,
  GET_UNRESOLVED_OBSERVATIONS,
  ObservationReview,
  REJECT_OBSERVATION,
  REVIEW_PAGE_SIZE,
  SEARCH_THINGS,
} from './ObservationReview';

type Observation = GetUnresolvedObservationsQuery['unresolvedObservations'][number];

const THING_ID = btoa('item:drill');

/**
 * `media`/`place`/`placeEntityId` are deliberately null: they are the picture
 * and the caption, not what this queue is about. They are plain fields on the
 * queue's own response now (DataLoader-backed @ResolveFields), so leaving them
 * null costs the tile nothing — it no longer issues a query of its own for
 * either.
 */
const makeObservation = (id: string, label: string): Observation =>
  ({
    __typename: 'ObjectObservationType' as const,
    id,
    label,
    labelSource: 'YOLO' as const,
    detector: 'yolo',
    detectorVersion: '8n',
    detectionConfidence: 0.82,
    resolutionConfidence: null,
    resolutionMethod: 'NONE' as const,
    confirmedByUser: false,
    observedAt: '2026-05-01T00:00:00.000Z',
    sourceKind: 'PHOTO' as const,
    placeEntityId: null,
    media: null,
    place: null,
    bbox: { __typename: 'BoundingBoxType' as const, x: 0.1, y: 0.1, w: 0.4, h: 0.4 },
  }) as Observation;

const queueMock = (observations: Observation[], offset = 0) =>
  mockQuery(
    GET_UNRESOLVED_OBSERVATIONS,
    { limit: REVIEW_PAGE_SIZE, offset },
    { unresolvedObservations: observations },
  );

const searchMock = (query: string, nodes: { id: string; name: string }[]) =>
  mockQuery(
    SEARCH_THINGS,
    { query },
    {
      items: {
        __typename: 'ItemConnection' as const,
        edges: nodes.map((node) => ({
          __typename: 'ItemEdge' as const,
          node: {
            __typename: 'ItemType' as const,
            id: node.id,
            name: node.name,
            brand: 'Makita',
            model: 'XPH',
            category: 'tools',
          },
        })),
      },
    },
  );

const RESOLVED_OBSERVATION = {
  __typename: 'ObjectObservationType' as const,
  id: 'obs-1',
  confirmedByUser: true,
  resolvedObjectId: THING_ID,
  resolutionMethod: 'USER' as const,
  resolutionConfidence: 1,
};

describe('ObservationReview', () => {
  it('lists the unresolved sightings with both answers the backend has a mutation for', async () => {
    renderWithProviders(<ObservationReview />, {
      mocks: [queueMock([makeObservation('obs-1', 'cordless drill')])],
    });

    // The label appears TWICE by design: as the tile's title, and as the
    // bounding box's caption — which is also the box's accessible name, so a
    // screen reader announces what the detector outlined instead of an unnamed
    // rectangle. Asserted by role/title rather than by text for that reason.
    expect(await screen.findByTitle('cordless drill')).toBeInTheDocument();
    expect(screen.getByRole('figure', { name: 'cordless drill' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'This is…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not a thing' })).toBeInTheDocument();
  });

  it('says the queue is empty rather than showing a bare card', async () => {
    renderWithProviders(<ObservationReview />, { mocks: [queueMock([])] });

    expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument();
  });

  it('rejects a sighting with its id alone, then re-reads the queue and the parent browse', async () => {
    const onResolved = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(<ObservationReview onResolved={onResolved} />, {
      mocks: [
        queueMock([makeObservation('obs-1', 'cordless drill')]),
        // Variable matching IS the assertion: an `id` other than 'obs-1' — or
        // any extra variable — misses this mock and the reject fails.
        mockQuery(REJECT_OBSERVATION, { id: 'obs-1' }, { rejectObservation: RESOLVED_OBSERVATION }),
        // The refetch that must follow. It resolves to an empty queue, so the
        // empty message appearing proves the re-read actually happened.
        queueMock([]),
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Not a thing' }));

    expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument();
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it('seeds the thing picker with the detector label and confirms against the picked id', async () => {
    const onResolved = vi.fn().mockResolvedValue(undefined);

    renderWithProviders(<ObservationReview onResolved={onResolved} />, {
      mocks: [
        queueMock([makeObservation('obs-1', 'cordless drill')]),
        // The picker searches the LABEL before the user types anything.
        searchMock('cordless drill', [{ id: THING_ID, name: 'Makita drill' }]),
        mockQuery(
          CONFIRM_OBSERVATION,
          { id: 'obs-1', itemId: THING_ID },
          { confirmObservation: RESOLVED_OBSERVATION },
        ),
        queueMock([]),
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'This is…' }));

    const dialog = await screen.findByRole('dialog');

    expect(dialog).toHaveTextContent('The detector labelled it "cordless drill"');

    fireEvent.click(await screen.findByText('Makita drill'));

    expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument();
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('searches what the user types instead of the label once they type', async () => {
    renderWithProviders(<ObservationReview />, {
      mocks: [
        queueMock([makeObservation('obs-1', 'cordless drill')]),
        searchMock('cordless drill', []),
        searchMock('lamp', [{ id: btoa('item:lamp'), name: 'Desk lamp' }]),
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'This is…' }));

    fireEvent.change(await screen.findByLabelText('Search your things'), { target: { value: 'lamp' } });

    expect(await screen.findByText('Desk lamp')).toBeInTheDocument();
  });

  it('keeps a failed reject on screen with the server message rather than swallowing it', async () => {
    renderWithProviders(<ObservationReview />, {
      mocks: [
        queueMock([makeObservation('obs-1', 'cordless drill')]),
        mockQuery(REJECT_OBSERVATION, { id: 'obs-1' }, { error: new Error('Sighting already resolved') }),
      ],
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Not a thing' }));

    expect(await screen.findByText('Sighting already resolved')).toBeInTheDocument();
    // The sighting is still there to try again on.
    expect(screen.getByTitle('cordless drill')).toBeInTheDocument();
  });

  it('pages by offset, and cannot page past a short page', async () => {
    const fullPage = Array.from({ length: REVIEW_PAGE_SIZE }, (_, index) =>
      makeObservation(`obs-${index}`, `sighting ${index}`),
    );

    renderWithProviders(<ObservationReview />, {
      mocks: [
        queueMock(fullPage),
        queueMock([makeObservation('obs-last', 'last sighting')], REVIEW_PAGE_SIZE),
      ],
    });

    expect(await screen.findByTitle('sighting 0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(await screen.findByTitle('last sighting')).toBeInTheDocument();
    expect(screen.getByText('Page 2')).toBeInTheDocument();
    // A short page is the only end-of-queue signal `unresolvedObservations` has.
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
  });
});
