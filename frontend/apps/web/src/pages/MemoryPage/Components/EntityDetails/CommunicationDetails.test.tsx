import { Sheet } from '@ci/shadcn';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { CommunicationDetails, GET_COMMUNICATION_ATTACHMENTS } from './CommunicationDetails';
import { EntityDrawerHostProvider } from './drawerHost';

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

// The relationship cards need the auth context for the REST graph endpoints; the drawer body is what's under test.
vi.mock('@/components/EntityRelationshipCards/EntityRelationshipCards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/EntityRelationshipCards/EntityRelationshipCards')>();

  return { ...actual, EntityRelationshipCards: () => null };
});

const COMM_UUID = '01a03f8a-0000-7000-8000-000000000001';
const COMM_GLOBAL_ID = btoa(`communication:${COMM_UUID}`);
const host = { setActiveEntity: vi.fn(), refetch: vi.fn() };

/** A Facebook post as the connector writes it: caption text, media linked through attachments. */
function post() {
  return {
    __typename: 'CommunicationType' as const,
    id: COMM_GLOBAL_ID,
    subject: null,
    preview: 'Music generated with MIDI Sprout',
    communicationContent: 'Music generated with MIDI Sprout',
    time: '2018-01-12T20:47:11.000Z',
    type: 'post',
    direction: 'outbound',
    from: null,
    to: { edges: [] },
    tags: [],
  };
}

function attachmentsMock(
  attachments: Array<Record<string, unknown>>,
  metadata: Record<string, unknown> = {},
) {
  return {
    request: { query: GET_COMMUNICATION_ATTACHMENTS, variables: { id: COMM_GLOBAL_ID } },
    result: {
      data: {
        node: {
          __typename: 'CommunicationType' as const,
          id: COMM_GLOBAL_ID,
          metadata,
          attachments: attachments.map((attachment) => ({
            __typename: 'CommunicationAttachmentType' as const,
            fileId: null,
            contentId: null,
            filename: null,
            contentType: null,
            url: null,
            previewUrl: null,
            width: null,
            height: null,
            size: null,
            ...attachment,
          })),
        },
      },
    },
  };
}

function renderPost(attachments: Array<Record<string, unknown>>, metadata: Record<string, unknown> = {}) {
  return renderWithProviders(
    <EntityDrawerHostProvider value={host}>
      <Sheet open>
        <CommunicationDetails entity={post() as never} />
      </Sheet>
    </EntityDrawerHostProvider>,
    { mocks: [attachmentsMock(attachments, metadata)] },
  );
}

describe('CommunicationDetails — link back to the source', () => {
  it('offers the post’s permalink from metadata as a new-tab link', async () => {
    renderPost([], { permalink_url: 'https://www.facebook.com/4410495569178178/posts/2096200610607697' });

    const link = await screen.findByRole('link', {
      name: 'https://www.facebook.com/4410495569178178/posts/2096200610607697',
    });

    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('never presents the shared `link` as the post itself — a photo post’s link is one photo’s page', async () => {
    renderPost([], {
      post_type: 'photo',
      link: 'https://www.facebook.com/photo.php?fbid=2109733299254428&set=a.2109586949269063&type=3',
    });

    const shared = await screen.findByRole('link', {
      name: 'https://www.facebook.com/photo.php?fbid=2109733299254428&set=a.2109586949269063&type=3',
    });

    expect(shared).toBeInTheDocument();
    expect(screen.getByText('Shared link')).toBeInTheDocument();
    expect(screen.queryByText('Link')).not.toBeInTheDocument();
  });

  it('shows both rows when the post has a permalink and points at something else', async () => {
    renderPost([], {
      permalink_url: 'https://www.facebook.com/4410495569178178/posts/2109733342587757',
      link: 'https://www.facebook.com/photo.php?fbid=2109733299254428',
    });

    await screen.findByText('Link');
    expect(screen.getByText('Shared link')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('shows no Link row when the metadata carries no URL', async () => {
    renderPost([], { post_type: 'status' });

    await screen.findByRole('heading', { name: 'Music generated with MIDI Sprout' });
    expect(screen.queryByText('Link')).not.toBeInTheDocument();
  });
});

describe('CommunicationDetails — attachments', () => {
  it('renders an attached video inline from the stored file', async () => {
    renderPost([
      {
        fileId: 'file-1',
        filename: 'facebook-video-2096266290601129.mp4',
        contentType: 'video/mp4',
        url: '/companion/abc?sig=1',
        previewUrl: '/companion/abc-preview?sig=1',
      },
    ]);

    const block = await screen.findByTestId('communication-attachments');

    // The sheet renders through a portal, so query from the block itself.
    const video = block.querySelector('video');

    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('src', '/static/companion/abc?sig=1');
    // The caption is still the title.
    expect(screen.getByRole('heading', { name: 'Music generated with MIDI Sprout' })).toBeInTheDocument();
  });

  it('renders an attached photo with its preview painted underneath the original', async () => {
    renderPost([
      {
        fileId: 'file-2',
        filename: 'facebook-photo-1.jpg',
        contentType: 'image/jpeg',
        url: '/companion/photo?sig=1',
        previewUrl: '/companion/photo-preview?sig=1',
      },
    ]);

    await screen.findByTestId('communication-attachments');

    const image = screen.getByRole('img', { name: 'facebook-photo-1.jpg' });

    // EntityMedia paints the PREVIEW first and swaps in the original once it
    // has loaded (see EntityMedia.test.tsx); in jsdom nothing loads, so the
    // preview is what stays on screen.
    expect(image).toHaveAttribute('src', '/static/companion/photo-preview?sig=1');
  });

  it('lists a non-media attachment by name as a link, not as media', async () => {
    renderPost([
      {
        fileId: 'file-3',
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
        url: '/companion/inv?sig=1',
      },
    ]);

    const link = await screen.findByRole('link', { name: 'invoice.pdf' });

    expect(link).toHaveAttribute('href', '/static/companion/inv?sig=1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.queryByTestId('communication-attachments')).not.toBeInTheDocument();
  });

  it('shows no media block for a message with no attachments', async () => {
    renderPost([]);

    expect(
      await screen.findByRole('heading', { name: 'Music generated with MIDI Sprout' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('communication-attachments')).not.toBeInTheDocument();
  });
});
