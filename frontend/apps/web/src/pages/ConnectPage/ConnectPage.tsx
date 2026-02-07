import { useEffect, useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { Portal } from '@ci/common';
import { Breadcrumb } from '@ci/shadcn';
import { useNavigate, Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';

import { Card } from './Card';

const GET_CONNECTIONS = gql(`
  query GetConnectionsLight {
    connections {
      edges {
        cursor
        node {
          id
          providerId
        }
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      totalCount
    }
  }
`);

interface ConnectCatalogProvider {
  key: string;
  providerId: string;
  displayName: string;
  lifecycle: 'active' | 'planned';
  connectable: boolean;
  description: string;
  logoUrl: string;
  theme: {
    backgroundColor: string;
    borderColor: string;
  };
}

export function ConnectPage() {
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<ConnectCatalogProvider[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const connectionsCount: Record<string, number> = {};

  const { data: getConnections } = useQuery(GET_CONNECTIONS);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        setCatalogLoading(true);
        setCatalogError(null);

        const response = await fetch('/api/providers/catalog');

        if (!response.ok) {
          throw new Error(`Failed to load provider catalog (${response.status})`);
        }

        const payload = (await response.json()) as ConnectCatalogProvider[];

        if (!cancelled) {
          setCatalog(payload);
        }
      } catch (error) {
        if (!cancelled) {
          setCatalogError(error instanceof Error ? error.message : 'Unable to load integrations');
        }
      } finally {
        if (!cancelled) {
          setCatalogLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, []);

  const connections = getConnections?.connections.edges.map((edge) => edge.node) || [];

  connections.forEach((c) => {
    if (connectionsCount[c.providerId]) {
      connectionsCount[c.providerId] += 1;
    } else {
      connectionsCount[c.providerId] = 1;
    }
  });

  const serviceProviders = useMemo(() => {
    return [...catalog].sort((a, b) => {
      if (a.connectable !== b.connectable) {
        return a.connectable ? -1 : 1;
      }

      return a.displayName.localeCompare(b.displayName);
    });
  }, [catalog]);

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Connect</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {/* Browser Extensions Section */}
        <div className="max-w-[1040px] mx-auto mb-8">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">Browser Extensions</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            Install our browser extensions to automatically capture your web activity and browsing patterns.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 md:gap-4">
            <Card
              logo="/branding/chrome/logo.svg"
              background="bg-blue-500"
              border="border-blue-400"
              text="Install the Chrome extension to automatically track your browsing history, bookmarks, and web activity."
              onClick={() => {
                window.open(
                  'https://chromewebstore.google.com/detail/companion-intelligence/bcocflgkdeimninckpmdifcniajoneih?authuser=3&hl=en',
                  '_blank',
                );
              }}
            />
            <Card
              logo="/branding/firefox/logo.svg"
              background="bg-orange-500"
              border="border-orange-400"
              text="Get the Firefox extension to capture your web browsing patterns and site interactions."
              disabled
            />
            <Card
              logo="/branding/safari/logo.svg"
              background="bg-blue-600"
              border="border-blue-500"
              text="Install the Safari extension for seamless web activity tracking on macOS and iOS."
              disabled
            />
          </div>
        </div>

        {/* Devices Section */}
        <div className="max-w-[1040px] mx-auto mb-8">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">Devices</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            Connect your smart devices and hardware to track usage patterns and environmental data.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 md:gap-4">
            <Card
              logo="/branding/home-assistant/logo.svg"
              background="bg-blue-500"
              border="border-blue-400"
              text="Connect Home Assistant to track your smart home interactions, automation usage, and device states."
              disabled
            />
            <Card
              logo="/branding/quest/logo.svg"
              background="bg-gray-800"
              border="border-gray-700"
              text="Link your Quest VR headset to use your camera for XR tracking and more to unlock embodied agentic immersive experiences."
              disabled
            />
            <Card
              logo="/branding/ios/logo.svg"
              background="bg-blue-500"
              border="border-blue-400"
              text="Download the iOS app to track your mobile usage, screen time, and app interactions on iPhone and iPad."
              disabled
            />
            <Card
              logo="/branding/android/logo.svg"
              background="bg-green-500"
              border="border-green-400"
              text="Install the Android app to monitor your device usage, notifications, and mobile activity patterns."
              disabled
            />
            <Card
              logo="/branding/windows/logo.svg"
              background="bg-blue-600"
              border="border-blue-500"
              text="Get the Windows app to track your desktop activity, application usage, and system interactions."
              disabled
            />
            <Card
              logo="/branding/mac/logo.svg"
              background="bg-gray-600"
              border="border-gray-500"
              text="Download the macOS app to monitor your Mac usage, workspace activity, and application patterns."
              disabled
            />
            <Card
              logo="/branding/linux/logo.svg"
              background="bg-yellow-600"
              border="border-yellow-500"
              text="Install the Linux app to track your system usage, command line activity, and development workflows."
              disabled
            />
          </div>
        </div>

        {/* Service Integrations Section */}
        <div className="max-w-[1040px] mx-auto">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">Service Integrations</h2>
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            Connect your favorite services to automatically sync your data and activities.
          </p>

          {catalogLoading ? <p className="text-sm text-muted-foreground">Loading integrations...</p> : null}
          {catalogError ? <p className="text-sm text-destructive">{catalogError}</p> : null}

          {!catalogLoading && !catalogError ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 md:gap-4">
              {serviceProviders.map((provider) => {
                const count = connectionsCount[provider.providerId] ?? 0;
                const subtext = count === 1 ? '1 Connection' : count > 1 ? `${count} Connections` : undefined;

                return (
                  <Card
                    key={provider.key}
                    logo={provider.logoUrl}
                    background={provider.theme.backgroundColor}
                    border={provider.theme.borderColor}
                    text={provider.description}
                    disabled={!provider.connectable}
                    onClick={() => navigate(`/providers/${provider.providerId}`)}
                    subtext={subtext}
                    className={count > 0 ? 'bg-green-200' : undefined}
                  />
                );
              })}
            </div>
          ) : null}
        </div>
      </PageContent>
    </>
  );
}
