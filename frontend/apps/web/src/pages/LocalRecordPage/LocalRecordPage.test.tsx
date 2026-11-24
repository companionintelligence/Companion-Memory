import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { LocalDocument } from '@/api/powersync/localSearch';
import { renderWithProviders } from '@/test/renderWithProviders';

const h = vi.hoisted(() => ({
  mode: 'cached' as string,
  documents: new Map<string, LocalDocument>(),
  siblings: { before: [] as LocalDocument[], after: [] as LocalDocument[] },
}));

vi.mock('@ci/common', async (orig) => ({
  ...(await orig<typeof import('@ci/common')>()),
  useConnectionMode: () => ({ mode: h.mode, isResolved: true }),
}));

vi.mock('@/api/powersync/session', () => ({
  getReplicaDatabase: () => ({}),
}));

vi.mock('@/api/powersync/localRecord', () => ({
  SIBLINGS_PAGE_SIZE: 20,
  getLocalDocument: async (_db: unknown, type: string, id: string) =>
    h.documents.get(`${type}:${id}`) ?? null,
  getLocalDocumentByEntityId: async (_db: unknown, id: string) =>
    [...h.documents.values()].find((document) => document.entityId === id) ?? null,
  listSiblings: async (_db: unknown, _related: string, side: 'before' | 'after') => h.siblings[side],
  countSiblings: async () => 1 + h.siblings.before.length + h.siblings.after.length,
}));

import { LocalRecordPage } from './LocalRecordPage';

const message = (id: string, body: string, occurredAt: string): LocalDocument => ({
  id: `doc-${id}`,
  entityType: 'communication',
  entityId: id,
  title: null,
  body,
  occurredAt,
  relatedId: 'conv-1',
  detail: { direction: 'inbound', participants: { from: 'Ana', to: ['Kyle'] }, source_system: 'discord' },
});

function renderAt(type: string, id: string) {
  return renderWithProviders(<LocalRecordPage />, {
    route: `/memory/saved/${type}/${id}`,
    path: '/memory/saved/:type/:id',
  });
}

describe('LocalRecordPage', () => {
  it('renders the phone’s copy of a message with its detail and conversation, and says it is the phone’s', async () => {
    h.mode = 'cached';
    h.documents.set('communication:c2', message('c2', 'running late', '2026-01-02T10:00:00.000Z'));
    h.siblings = {
      before: [message('c1', 'where are you?', '2026-01-02T09:55:00.000Z')],
      after: [message('c3', 'ok', '2026-01-02T10:01:00.000Z')],
    };
    renderAt('communication', 'c2');

    expect(await screen.findByRole('heading', { level: 1, name: 'running late' })).toBeInTheDocument();
    expect(screen.getByTestId('saved-banner')).toHaveTextContent('Saved on this phone');
    expect(screen.getByText('Inbound')).toBeInTheDocument();
    expect(screen.getByText('From Ana · To Kyle')).toBeInTheDocument();
    expect(screen.getByText('Discord')).toBeInTheDocument();

    const conversation = screen.getByTestId('conversation');

    expect(conversation).toHaveTextContent('where are you?');
    expect(conversation).toHaveTextContent('ok');
    expect(conversation).toHaveTextContent('3');
    // Not connected: no way to the full record is offered.
    expect(screen.queryByRole('link', { name: 'Open full record' })).not.toBeInTheDocument();
  });

  it('offers the full record once connected, at the type’s own page', async () => {
    h.mode = 'connected';
    h.documents.set('event:e1', {
      id: 'doc-e1',
      entityType: 'event',
      entityId: 'e1',
      title: 'Dentist',
      body: null,
      occurredAt: '2026-01-02T10:00:00.000Z',
      relatedId: null,
      detail: { status: 'confirmed', is_all_day: false },
    });
    renderAt('event', 'e1');

    expect(await screen.findByRole('heading', { level: 1, name: 'Dentist' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open full record' })).toHaveAttribute('href', '/events/e1');
    expect(screen.queryByTestId('conversation')).not.toBeInTheDocument();
  });

  it('a record that belongs with another links to it when the phone holds that one too', async () => {
    h.mode = 'cached';
    h.documents.set('event:parent', {
      id: 'doc-parent',
      entityType: 'event',
      entityId: 'parent',
      title: 'Trip to Palermo',
      body: null,
      occurredAt: null,
      relatedId: null,
      detail: null,
    });
    h.documents.set('content:photo', {
      id: 'doc-photo',
      entityType: 'content',
      entityId: 'photo',
      title: 'Harbour at dusk',
      body: null,
      occurredAt: null,
      relatedId: 'parent',
      detail: { mimetype: 'image/jpeg' },
    });
    renderAt('content', 'photo');

    expect(await screen.findByRole('heading', { level: 1, name: 'Harbour at dusk' })).toBeInTheDocument();
    expect(screen.getByText('Part of')).toBeInTheDocument();
    expect(screen.getByText('Trip to Palermo')).toBeInTheDocument();
  });

  it('says so when this phone has no copy', async () => {
    h.mode = 'cached';
    renderAt('note', 'nope');

    await waitFor(() => expect(screen.getByText('Not saved on this phone')).toBeInTheDocument());
  });
});
