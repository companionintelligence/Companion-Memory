import { Sheet } from '@ci/shadcn';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/renderWithProviders';

import { EntityDrawerHostProvider } from './drawerHost';
import { GenericDetails, pickImageProperty, pickPageUrl } from './GenericDetails';

vi.mock('@/components/ChatWithAgent', () => ({
  ChatWithAgentMenu: () => null,
}));

// The relationship cards need the auth context for the REST graph endpoints; the drawer body is what's under test.
vi.mock('@/components/EntityRelationshipCards/EntityRelationshipCards', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/EntityRelationshipCards/EntityRelationshipCards')>();

  return { ...actual, EntityRelationshipCards: () => null };
});

const host = { setActiveEntity: vi.fn(), refetch: vi.fn() };

/** The Organization node the Facebook connector mints for a liked Page. */
const organization = {
  __typename: 'GenericEntity' as const,
  id: '01a03fb1-df48-75d0-89f9-3a4972da17cb',
  entityType: 'Organization',
  name: 'LifeScope',
  description: 'Software Company',
  properties: {
    facebook_page_id: '170342537143457',
    category: 'Software Company',
    url: 'https://www.facebook.com/170342537143457',
    cover_url: 'https://scontent-lax3-2.xx.fbcdn.net/v/t39.30808-6/cover.png?oe=6A95111E',
    connection_id: 'conn-1',
  },
};

function renderOrganization() {
  return renderWithProviders(
    <EntityDrawerHostProvider value={host}>
      <Sheet open>
        <GenericDetails entity={organization} />
      </Sheet>
    </EntityDrawerHostProvider>,
  );
}

describe('GenericDetails', () => {
  it('links an http(s) property out in a new tab instead of printing it as text', async () => {
    renderOrganization();

    const link = await screen.findByRole('link', { name: 'https://www.facebook.com/170342537143457' });

    expect(link).toHaveAttribute('href', 'https://www.facebook.com/170342537143457');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the cover image as the drawer media rather than as a URL row', async () => {
    renderOrganization();

    const cover = await screen.findByRole('img', { name: 'LifeScope' });

    expect(cover).toHaveAttribute('src', organization.properties.cover_url);
    // Not ALSO listed as a property row — the picture is the property.
    expect(screen.queryByText('cover_url')).not.toBeInTheDocument();
    expect(screen.getByText('category')).toBeInTheDocument();
  });

  it('still lists plain properties as text', async () => {
    renderOrganization();

    expect(await screen.findByText('170342537143457')).toBeInTheDocument();
    expect(screen.getByText('Organization')).toBeInTheDocument();
  });
});

describe('pickImageProperty / pickPageUrl', () => {
  it('picks the first image-shaped http property and ignores non-URLs under image keys', () => {
    expect(pickImageProperty({ cover_url: 'not a url', avatar: 'https://cdn.test/a.png' })).toEqual([
      'avatar',
      'https://cdn.test/a.png',
    ]);
    expect(pickImageProperty({ url: 'https://example.test/page' })).toBeNull();
  });

  it('prefers the entity’s own page URL for the media fallback link', () => {
    expect(pickPageUrl({ website: 'https://lifescope.io', cover_url: 'https://cdn.test/c.png' })).toBe(
      'https://lifescope.io',
    );
    expect(pickPageUrl({ cover_url: 'https://cdn.test/c.png' })).toBeNull();
  });
});
