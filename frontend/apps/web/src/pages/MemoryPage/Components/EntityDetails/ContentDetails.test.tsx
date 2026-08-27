import { Sheet } from '@ci/shadcn';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CONTENT_FRAGMENT } from '@/components/entities/grid/ContentGridItem';
import { makeFragmentData } from '@/graphql';
import { renderWithProviders } from '@/test/renderWithProviders';

import { ContentDetails } from './ContentDetails';
import { EntityDrawerHostProvider } from './drawerHost';

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

vi.mock('@/components/EntityRelationshipCards/EntityRelationshipCards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/EntityRelationshipCards/EntityRelationshipCards')>();

  return { ...actual, EntityRelationshipCards: () => null };
});

const CONTENT_UUID = '01a04136-0ced-7697-99d9-69badb411863';
const CONTENT_GLOBAL_ID = btoa(`content:${CONTENT_UUID}`);
const host = { setActiveEntity: vi.fn(), refetch: vi.fn() };

function makeEntity(overrides: Record<string, unknown> = {}) {
  return {
    ...makeFragmentData(
      {
        __typename: 'ContentType' as const,
        id: CONTENT_GLOBAL_ID,
        title: 'invoice448421297.pdf',
        text: '',
        contentUrl: null,
        sourceUrl: null,
        sourceType: null,
        sourceSystem: null,
        sourceId: null,
        createdAt: '2026-08-26T12:00:00.000Z',
        mimetype: 'application/pdf',
        mediaUrl: null,
        mediaFilename: null,
        mediaSize: null,
        previewUrl: null,
        player: null,
        unfurl: null,
        ...overrides,
      },
      CONTENT_FRAGMENT,
    ),
    tags: [],
  };
}

function renderDrawer(overrides: Record<string, unknown> = {}) {
  return renderWithProviders(
    <EntityDrawerHostProvider value={host}>
      <Sheet open>
        <ContentDetails entity={makeEntity(overrides) as never} />
      </Sheet>
    </EntityDrawerHostProvider>,
  );
}

describe('ContentDetails stored files', () => {
  it('opens a stored PDF in a new tab and shows filename, size and source', async () => {
    renderDrawer({
      mediaUrl: '/companion/invoice-key?X-Amz-Signature=sig',
      mediaFilename: 'invoice448421297.pdf',
      mediaSize: 102400,
      sourceSystem: 'gmail',
      sourceType: 'email',
      sourceUrl: 'https://mail.google.com/mail/u/0/#inbox/abc',
    });

    const open = await screen.findByRole('link', { name: 'Open' });
    expect(open).toHaveAttribute('href', '/static/companion/invoice-key?X-Amz-Signature=sig');
    expect(open).toHaveAttribute('target', '_blank');

    expect(screen.getByRole('heading', { name: 'invoice448421297.pdf' })).toBeInTheDocument();
    expect(screen.getByText('Filename')).toBeInTheDocument();
    expect(screen.getByText('100.0 KB')).toBeInTheDocument();
    expect(screen.getByText('Gmail')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://mail.google.com/mail/u/0/#inbox/abc' })).toHaveAttribute(
      'target',
      '_blank',
    );
    expect(screen.queryByText('Text')).not.toBeInTheDocument();
  });

  it('opens a non-PDF stored file the same way', async () => {
    renderDrawer({
      title: 'notes.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      mediaUrl: '/companion/notes-key',
      mediaFilename: 'notes.docx',
    });

    const open = await screen.findByRole('link', { name: 'Open' });
    expect(open).toHaveAttribute('href', '/static/companion/notes-key');
    expect(open).toHaveAttribute('target', '_blank');
  });

  it('does not offer Open when there are no stored bytes', async () => {
    renderDrawer({ mediaUrl: null, mimetype: 'application/pdf' });

    await screen.findByRole('heading', { name: 'invoice448421297.pdf' });
    expect(screen.queryByRole('link', { name: 'Open' })).not.toBeInTheDocument();
  });

  it('offers Open source when the only URL is an http origin', async () => {
    renderDrawer({
      mediaUrl: null,
      contentUrl: 'https://drive.google.com/file/d/abc',
      mimetype: 'application/pdf',
    });

    const open = await screen.findByRole('link', { name: 'Open source' });
    expect(open).toHaveAttribute('href', 'https://drive.google.com/file/d/abc');
    expect(open).toHaveAttribute('target', '_blank');
  });

  it('does not add an Open control on an inline image that already has EntityMedia', async () => {
    renderDrawer({
      title: 'photo.jpg',
      mimetype: 'image/jpeg',
      mediaUrl: '/companion/photo',
      mediaFilename: 'photo.jpg',
    });

    await screen.findByRole('heading', { name: 'photo.jpg' });
    expect(screen.queryByRole('link', { name: 'Open' })).not.toBeInTheDocument();
  });
});
