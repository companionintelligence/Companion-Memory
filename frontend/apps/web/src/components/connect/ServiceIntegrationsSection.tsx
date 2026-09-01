import { useMemo, useState } from 'react';

import { useQuery, gql } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { cn, Dialog, Button } from '@ci/shadcn';
import {
  Activity,
  Award,
  Bookmark,
  Calendar,
  CircleUser,
  Contact,
  Files,
  FileText,
  Folder,
  GitBranch,
  GitCommit,
  Hash,
  Heart,
  Image,
  ListMusic,
  Mail,
  MessageSquare,
  Music,
  Package,
  Play,
  ShoppingBag,
  Table,
  Timer,
  Users,
  Video,
} from '@ci/shadcn/icons';
import { useNavigate } from 'react-router-dom';

import { SourceCard, type TrackedObject } from '@/components/connect/SourceCard';
import { useBlueBubblesStatus } from '@/components/connect/useBlueBubblesStatus';
import { GET_PROVIDERS, GET_OAUTH_CALLBACK_URL } from '@/queries';

const GET_CONNECTIONS = gql`
  query GetConnectionsForOnboarding {
    connections {
      edges {
        node {
          id
          name
          active
          needsReauth
          providerId
          syncState
        }
      }
    }
  }
`;

/**
 * When this connection last actually pulled something.
 *
 * `syncState` is an untyped JSON column the connection runner owns; the server
 * reads `lastSyncedAt` off it for its own summaries, so this reads the same
 * key rather than inventing a second convention. Anything else in there is
 * none of this card's business.
 */
function lastSyncedAt(syncState: unknown): string | null {
  if (syncState == null || typeof syncState !== 'object') {
    return null;
  }

  const value = (syncState as { lastSyncedAt?: unknown }).lastSyncedAt;

  return typeof value === 'string' ? value : null;
}

export interface ServiceProviderConfig {
  rawId: string;
  logo: string;
  /** The service, as someone would say it out loud. */
  name: string;
  /**
   * What connecting it actually puts in your memory.
   *
   * These cards used to carry a sentence of marketing per service ("Link your
   * Google account for Gmail, Calendar, Drive, Photos, and YouTube") on a
   * full-bleed brand-coloured block — three to a row, one screen per six
   * services, and the answer to "what do I get" buried in prose you had to
   * read to compare anything. A named list of objects is the same information
   * scannable: down a column, in the same position on every card.
   */
  tracks: TrackedObject[];
  disabled?: boolean;
}

/** Connection GraphQL historically returned raw UUIDs; accept encoded or raw provider ids. */
function toRawProviderId(providerId: string): string {
  try {
    return GlobalUID.parse('provider', providerId);
  } catch {
    return providerId;
  }
}

export const SERVICE_PROVIDERS: ServiceProviderConfig[] = [
  {
    rawId: '0198779b-3c33-73da-84e5-82e0df145260',
    logo: '/branding/microsoft/logo.svg',
    name: 'Microsoft',
    tracks: [
      { icon: Mail, label: 'Outlook mail' },
      { icon: Calendar, label: 'Calendar' },
      { icon: Contact, label: 'Contacts' },
      { icon: Folder, label: 'OneDrive files' },
    ],
  },
  {
    rawId: '0198779b-182c-716e-9275-b81d99a47fdb',
    logo: '/branding/google/logo.svg',
    name: 'Google',
    tracks: [
      { icon: Mail, label: 'Gmail' },
      { icon: Calendar, label: 'Calendar' },
      { icon: Image, label: 'Photos' },
      { icon: Folder, label: 'Drive files' },
      { icon: Play, label: 'YouTube history' },
    ],
  },
  {
    rawId: 'dbb8002f-12da-4cd9-b02b-37db7791a900',
    logo: '/branding/meta/logo.svg',
    name: 'Meta',
    tracks: [
      { icon: MessageSquare, label: 'Posts' },
      { icon: Image, label: 'Photos' },
      { icon: Video, label: 'Videos' },
      { icon: Users, label: 'Friends' },
    ],
  },
  {
    rawId: '019cbaf2-d789-7723-aada-7e3d709663f5',
    logo: '/branding/spotify/logo.svg',
    name: 'Spotify',
    tracks: [
      { icon: Music, label: 'Listening history' },
      { icon: ListMusic, label: 'Playlists' },
      { icon: Heart, label: 'Saved tracks' },
    ],
  },
  {
    rawId: '019d6470-f9e1-720f-a3ce-299842abaece',
    logo: '/branding/steam/logo.svg',
    name: 'Steam',
    tracks: [
      { icon: Package, label: 'Game library' },
      { icon: Timer, label: 'Playtime' },
      { icon: Award, label: 'Achievements' },
    ],
  },
  {
    rawId: '019d7a32-e4b0-7f01-b5c2-8a1d3e6f9c04',
    logo: '/branding/github/logo.svg',
    name: 'GitHub',
    tracks: [
      { icon: GitBranch, label: 'Repositories' },
      { icon: GitCommit, label: 'Commits' },
      { icon: Activity, label: 'Issues & pull requests' },
    ],
  },
  {
    rawId: '019e3d77-c6e3-8f14-da06-2b5f7c0e1d19',
    logo: '/branding/signal/logo.svg',
    name: 'Signal',
    tracks: [
      { icon: MessageSquare, label: 'Messages' },
      { icon: Contact, label: 'Contacts' },
    ],
  },
  {
    rawId: '019e3c66-b5d2-7f03-c9e5-1a4f6b9d0c08',
    logo: '/branding/slack/logo.svg',
    name: 'Slack',
    tracks: [
      { icon: MessageSquare, label: 'Messages' },
      { icon: Hash, label: 'Channels' },
    ],
  },
  {
    rawId: '019e2b55-a4c1-7f02-b8d4-0c3e5a8f6b07',
    logo: '/branding/reddit/logo.svg',
    name: 'Reddit',
    tracks: [
      { icon: MessageSquare, label: 'Posts & comments' },
      { icon: Bookmark, label: 'Saved' },
    ],
  },
  {
    rawId: 'discord',
    logo: '/branding/discord/logo.svg',
    name: 'Discord',
    tracks: [
      { icon: MessageSquare, label: 'Messages' },
      { icon: Hash, label: 'Servers & channels' },
    ],
    disabled: true,
  },
  {
    rawId: 'instagram',
    logo: '/branding/instagram/logo.svg',
    name: 'Instagram',
    tracks: [
      { icon: Image, label: 'Photos' },
      { icon: Video, label: 'Stories & reels' },
      { icon: MessageSquare, label: 'Comments' },
    ],
    disabled: true,
  },
  {
    rawId: 'shopify',
    logo: '/branding/shopify/logo.svg',
    name: 'Shopify',
    tracks: [
      { icon: ShoppingBag, label: 'Orders' },
      { icon: Package, label: 'Products' },
    ],
    disabled: true,
  },
  {
    rawId: 'x',
    logo: '/branding/x/logo.svg',
    name: 'X',
    tracks: [
      { icon: MessageSquare, label: 'Posts' },
      { icon: Heart, label: 'Likes' },
      { icon: Users, label: 'Follows' },
    ],
    disabled: true,
  },
  {
    rawId: 'linkedin',
    logo: '/branding/linkedin/logo.svg',
    name: 'LinkedIn',
    tracks: [
      { icon: Users, label: 'Connections' },
      { icon: CircleUser, label: 'Positions' },
      { icon: MessageSquare, label: 'Posts' },
    ],
    disabled: true,
  },
  {
    rawId: 'notion',
    logo: '/branding/notion/logo.svg',
    name: 'Notion',
    tracks: [
      { icon: FileText, label: 'Pages' },
      { icon: Table, label: 'Databases' },
    ],
    disabled: true,
  },
  {
    rawId: 'twitch',
    logo: '/branding/twitch/logo.svg',
    name: 'Twitch',
    tracks: [
      { icon: Video, label: 'Watch history' },
      { icon: Users, label: 'Follows' },
    ],
    disabled: true,
  },
  {
    rawId: 'dropbox',
    logo: '/branding/dropbox/logo.svg',
    name: 'Dropbox',
    tracks: [
      { icon: Files, label: 'Files' },
      { icon: Folder, label: 'Shared folders' },
    ],
    disabled: true,
  },
];

/**
 * Same shape as Signal's tracks — both are text-message history plus who it
 * was with — since BlueBubbles is also iMessage/SMS, just off a self-hosted
 * Mac rather than an OAuth account.
 */
const BLUEBUBBLES_TRACKS: TrackedObject[] = [
  { icon: MessageSquare, label: 'Messages' },
  { icon: Contact, label: 'Contacts' },
];

interface SetupProviderState {
  name: string;
  appSetupUrl: string | null;
  scopes: string[] | null;
}

interface ServiceIntegrationsSectionProps {
  variant?: 'page' | 'onboarding';
  onProviderSelect?: (rawProviderId: string) => void;
}

export function ServiceIntegrationsSection({
  variant = 'page',
  onProviderSelect,
}: ServiceIntegrationsSectionProps) {
  const navigate = useNavigate();
  const { data: providersData } = useQuery(GET_PROVIDERS, {
    fetchPolicy: 'cache-and-network',
  });
  const { data: connectionsData } = useQuery(GET_CONNECTIONS, {
    fetchPolicy: 'cache-and-network',
  });
  const { data: oauthData } = useQuery(GET_OAUTH_CALLBACK_URL);
  const blueBubbles = useBlueBubblesStatus();

  const callbackUrl = oauthData?.oAuthCallbackUrl ?? `${window.location.origin}/oauth/callback`;

  const [setupProvider, setSetupProvider] = useState<SetupProviderState | null>(null);

  const connections =
    connectionsData?.connections?.edges?.map(
      (edge: { node: { providerId: string; active: boolean; syncState?: unknown } }) => edge.node,
    ) ?? [];

  const connectionsCount: Record<string, number> = {};
  const lastSyncByProvider: Record<string, string> = {};

  connections.forEach((c: { providerId: string; active: boolean; syncState?: unknown }) => {
    if (!c.active) {
      return;
    }

    const rawId = toRawProviderId(c.providerId);
    connectionsCount[rawId] = (connectionsCount[rawId] ?? 0) + 1;

    // Newest wins: with two Google accounts the card should report the one
    // that ran most recently, not whichever the server listed first.
    const synced = lastSyncedAt(c.syncState);

    if (synced && (lastSyncByProvider[rawId] == null || synced > lastSyncByProvider[rawId])) {
      lastSyncByProvider[rawId] = synced;
    }
  });

  const providers =
    providersData?.providers.edges.map(
      (edge: {
        node: {
          id: string;
          name: string;
          localOnly: boolean;
          providerKeys: unknown;
          appSetupUrl: string | null;
          scopes: string[] | null;
        };
      }) => edge.node,
    ) || [];

  const providerMap = useMemo(() => {
    const map: Record<string, (typeof providers)[number]> = {};
    providers.forEach((p: (typeof providers)[number]) => {
      map[GlobalUID.parse('provider', p.id)] = p;
    });

    return map;
  }, [providers]);

  function handleProviderClick(rawId: string) {
    const provider = providerMap[rawId];
    const isLocalOnlyWithoutKeys = provider?.localOnly && !provider?.providerKeys;

    if (isLocalOnlyWithoutKeys) {
      setSetupProvider({
        name: provider.name ?? 'Provider',
        appSetupUrl: provider.appSetupUrl ?? null,
        scopes: provider.scopes ?? null,
      });

      return;
    }

    if (onProviderSelect) {
      onProviderSelect(rawId);

      return;
    }

    navigate(`/providers/${rawId}`);
  }

  return (
    <>
      {/* Three to a row, as on every other path. The cards are a list of names
          rather than seventeen full-bleed brand panels, so the catalogue is
          comparable at a glance either way — and matching the other paths
          matters more than fitting one more column. */}
      <div
        className={cn(
          'grid grid-cols-1 gap-2 sm:grid-cols-2 md:gap-4 lg:grid-cols-3',
          variant === 'onboarding' && 'max-w-6xl',
        )}
      >
        {SERVICE_PROVIDERS.map((config) => {
          const count = connectionsCount[config.rawId] ?? 0;

          return (
            <SourceCard
              key={config.rawId}
              logo={config.logo}
              name={config.name}
              tracks={config.tracks}
              count={count}
              lastActivityAt={lastSyncByProvider[config.rawId] ?? null}
              activityVerb="synced"
              // `disabled` is "not implemented yet". Connected cards stay
              // clickable so a second account of the same service can be added,
              // matching /sources/connect.
              comingSoon={Boolean(config.disabled)}
              onSelect={() => handleProviderClick(config.rawId)}
            />
          );
        })}

        {/* Not one of the OAuth `providers` above — a single appliance-wide
            connection configured on its own settings page (see
            useBlueBubblesStatus) — so it isn't in `SERVICE_PROVIDERS` and
            can't route through `handleProviderClick`. Onboarding skips it: it
            needs a self-hosted Mac reachable from this appliance, not a
            one-click sign-in. */}
        {variant === 'page' && (
          <SourceCard
            icon={<MessageSquare aria-hidden className="h-full w-full" strokeWidth={1.5} />}
            name="BlueBubbles"
            tracks={BLUEBUBBLES_TRACKS}
            count={blueBubbles.enabled ? 1 : 0}
            lastActivityAt={blueBubbles.lastActivityAt}
            activityVerb="synced"
            onSelect={() => navigate('/settings/bluebubbles')}
          />
        )}
      </div>

      <Dialog open={setupProvider != null} onOpenChange={() => setSetupProvider(null)}>
        <Dialog.Content className="sm:max-w-[500px] [&>button]:cursor-pointer">
          <Dialog.Header>
            <Dialog.Title>{setupProvider?.name} — OAuth Setup</Dialog.Title>
            <Dialog.Description>
              We cannot provide cloud OAuth for this provider at this time, but you can create and connect
              your own OAuth app for this provider. See{' '}
              <a
                href={setupProvider?.appSetupUrl ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-blue-600"
              >
                this link
              </a>{' '}
              for more information on creating an app.
            </Dialog.Description>
          </Dialog.Header>
          <ul className="px-6 pb-4 space-y-3 text-sm text-gray-700 dark:text-gray-300 list-disc list-outside">
            <li>If the setup asks for an app type, it should be &apos;Web&apos;.</li>
            <li>
              The callback URL you need to register with the app is{' '}
              <code className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-xs break-all">
                {callbackUrl}
              </code>
              .
            </li>
            {setupProvider?.scopes && setupProvider.scopes.length > 0 && (
              <li>
                You may need to explicitly enable the following scopes on the OAuth app:
                <ul className="mt-2 space-y-1 list-disc list-outside ml-6">
                  {setupProvider.scopes.map((scope) => (
                    <li key={scope}>
                      <code className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-xs break-all">
                        {scope}
                      </code>
                    </li>
                  ))}
                </ul>
              </li>
            )}
            <li>Once you have made the OAuth app, you will need to generate a secret in the OAuth app.</li>
            <li>
              With the OAuth app&apos;s ID/Client ID and Secret in hand, go to{' '}
              <a href="/settings/oauth" className="underline text-blue-600 hover:text-blue-800">
                Settings → OAuth Credentials
              </a>{' '}
              in this app, and copy the app&apos;s ID/Client ID to the &apos;Client ID&apos; field for that
              provider, and the app&apos;s secret to &apos;Client Secret&apos; field. Make sure to save. Then
              come back to this page.
            </li>
          </ul>
          <Dialog.Footer>
            <Button variant="outline" onClick={() => setSetupProvider(null)}>
              Close
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}

export { GET_CONNECTIONS as GET_CONNECTIONS_LIGHT };
