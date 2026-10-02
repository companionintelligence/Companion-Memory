/**
 * AddEventModal: the hand-made path into ci.events, which until now only had
 * an importer. The mutation is stubbed, so this suite is about the modal's own
 * wiring — that an invalid draft never reaches the network, what the valid one
 * actually sends, and that a rejected write keeps the user's typing.
 */
import type { MockedResponse } from '@apollo/client/testing';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { gql } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { AddEventModal } from './AddEventModal';

const CREATE_EVENT = gql(`
  mutation CreateEvent($input: CreateEventInput!) {
    createEvent(input: $input) {
      id
      title
      description
      startTime
      endTime
      eventType
      locationName
    }
  }
`);

function renderModal(mocks: MockedResponse[] = []) {
  const onClose = vi.fn();
  const onCreated = vi.fn();

  renderWithProviders(<AddEventModal open onClose={onClose} onCreated={onCreated} />, { mocks });

  return { onClose, onCreated };
}

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

/** A create mock that records the input it was called with. */
function createMock(capture: (input: Record<string, unknown>) => void): MockedResponse {
  return {
    request: { query: CREATE_EVENT },
    variableMatcher: (variables: { input: Record<string, unknown> }) => {
      capture(variables.input);

      return true;
    },
    result: {
      data: {
        createEvent: {
          __typename: 'EventType',
          id: 'event-1',
          title: 'Dinner with Sam',
          description: null,
          startTime: '2026-08-19T17:00:00.000Z',
          endTime: null,
          eventType: null,
          locationName: null,
        },
      },
    },
  } as unknown as MockedResponse;
}

describe('AddEventModal — validation', () => {
  it('refuses to submit an untitled event and says so, without calling the mutation', async () => {
    const sent = vi.fn();
    const { onClose } = renderModal([createMock(sent)]);

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    // Beside the field, which says which one, and above the buttons.
    expect(await screen.findAllByText(/give the event a title/i)).toHaveLength(2);
    expect(sent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // ═══ THE REASON USED TO BE ONLY WHERE THE FINGER WASN'T ═══
  //
  // The form scrolls inside the modal while Add sits in a fixed footer under it,
  // so a refusal drawn beside the offending field — which can be scrolled out of
  // view — left Add looking dead. The sentence now also sits directly above the
  // buttons, in the slot a rejected write already uses.
  it('says what is wrong directly above the Add button, not only beside the field', () => {
    renderModal();

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    const alert = screen.getByRole('alert');

    expect(alert).toHaveTextContent(/give the event a title/i);
    expect(alert.nextElementSibling).toContainElement(screen.getByRole('button', { name: /^add$/i }));
  });

  it('refuses an end that precedes the start', async () => {
    const sent = vi.fn();
    renderModal([createMock(sent)]);

    fill(/^title$/i, 'Dinner with Sam');
    fill(/^starts$/i, '2026-08-19');
    fill(/^ends$/i, '2026-08-18');

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(await screen.findAllByText(/ends before it starts/i)).toHaveLength(2);
    expect(sent).not.toHaveBeenCalled();
  });

  it('refuses half a coordinate pair rather than dropping it silently', async () => {
    const sent = vi.fn();
    renderModal([createMock(sent)]);

    fill(/^title$/i, 'Dinner with Sam');
    fill(/^latitude$/i, '37.7749');

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(await screen.findAllByText(/both a latitude/i)).toHaveLength(2);
    expect(sent).not.toHaveBeenCalled();
  });
});

describe('AddEventModal — creating the event', () => {
  it('sends the draft, notifies the caller to refetch, and closes', async () => {
    const inputs: Record<string, unknown>[] = [];
    const { onClose, onCreated } = renderModal([createMock((input) => inputs.push(input))]);

    fill(/^title$/i, 'Dinner with Sam');
    fill(/^place$/i, 'Zuni Cafe');

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(false));

    expect(inputs[0]).toMatchObject({ title: 'Dinner with Sam', locationName: 'Zuni Cafe' });
    // Blank means "no kind", which is what keeps a user-made event on the
    // Schedule (CalendarEventService.findInRange serves NULL event_type).
    expect(inputs[0].eventType).toBeUndefined();
    expect(typeof inputs[0].startTime).toBe('string');
  });

  it('hides the clock fields for an all-day event and flags it on the input', async () => {
    const inputs: Record<string, unknown>[] = [];
    renderModal([createMock((input) => inputs.push(input))]);

    fill(/^title$/i, 'Move house');
    expect(screen.getAllByLabelText(/^at$/i)).toHaveLength(2);

    fireEvent.click(screen.getByLabelText(/all day/i));
    expect(screen.queryAllByLabelText(/^at$/i)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(inputs).toHaveLength(1));
    expect(inputs[0].isAllDay).toBe(true);
  });

  it('keeps the draft and shows the error when the write is rejected', async () => {
    const { onClose, onCreated } = renderModal([
      {
        request: { query: CREATE_EVENT },
        variableMatcher: () => true,
        error: new Error('network down'),
      } as unknown as MockedResponse,
    ]);

    fill(/^title$/i, 'Dinner with Sam');
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/network down/i);
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^title$/i)).toHaveValue('Dinner with Sam');
  });
});
