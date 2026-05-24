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

export function ConnectPage() {
  const navigate = useNavigate();
  const connectionsCount: Record<string, number> = {};

  const { data: getConnections } = useQuery(GET_CONNECTIONS);

  const connections = getConnections?.connections.edges.map((edge) => edge.node) || [];

  connections.forEach((c) => {
    if (connectionsCount[c.providerId]) {
      connectionsCount[c.providerId] += 1;
    } else {
      connectionsCount[c.providerId] = 1;
    }
  });

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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 md:gap-4">
            <Card
              logo="/branding/microsoft/logo.svg"
              background="bg-sky-400"
              border="border-sky-300"
              text="Bring your Microsoft account into the mix for email and scheduling. Keep track of what matters without extra steps."
              onClick={() => navigate('/providers/0198779b-3c33-73da-84e5-82e0df145260')}
              subtext={
                connectionsCount['0198779b-3c33-73da-84e5-82e0df145260'] === 1
                  ? `1 Connection`
                  : connectionsCount['0198779b-3c33-73da-84e5-82e0df145260'] > 1
                    ? `${connectionsCount['0198779b-3c33-73da-84e5-82e0df145260']} Connections`
                    : undefined
              }
              className={
                connectionsCount['0198779b-3c33-73da-84e5-82e0df145260'] > 0 ? 'bg-green-200' : undefined
              }
            />
            <Card
              logo="/branding/google/logo.svg"
              background="bg-violet-400"
              border="border-violet-300"
              text="Link your Google account for quick access to Gmail, Calendar, Drive, Photos, and Youtube. Everything you need, always in sync."
              onClick={() => navigate('/providers/0198779b-182c-716e-9275-b81d99a47fdb')}
              subtext={
                connectionsCount['0198779b-182c-716e-9275-b81d99a47fdb'] === 1
                  ? `1 Connection`
                  : connectionsCount['0198779b-182c-716e-9275-b81d99a47fdb'] > 1
                    ? `${connectionsCount['0198779b-182c-716e-9275-b81d99a47fdb']} Connections`
                    : undefined
              }
              className={
                connectionsCount['0198779b-182c-716e-9275-b81d99a47fdb'] > 0 ? 'bg-green-200' : undefined
              }
            />
            <Card
              logo="/branding/meta/logo.svg"
              background="bg-blue-500"
              border="border-blue-400"
              text="Connect your Meta account to sync your Facebook posts, photos, videos, friends, and likes. Stay connected with your community."
              onClick={() => navigate('/providers/dbb8002f-12da-4cd9-b02b-37db7791a900')}
              subtext={
                connectionsCount['dbb8002f-12da-4cd9-b02b-37db7791a900'] === 1
                  ? `1 Connection`
                  : connectionsCount['dbb8002f-12da-4cd9-b02b-37db7791a900'] > 1
                    ? `${connectionsCount['dbb8002f-12da-4cd9-b02b-37db7791a900']} Connections`
                    : undefined
              }
              className={
                connectionsCount['dbb8002f-12da-4cd9-b02b-37db7791a900'] > 0 ? 'bg-green-200' : undefined
              }
            />
            <Card
              logo="/branding/spotify/logo.svg"
              background="bg-green-500"
              border="border-green-400"
              text="Connect Spotify to track your music listening habits, playlists, and audio memories."
              onClick={() => navigate('/providers/019cbaf2-d789-7723-aada-7e3d709663f5')}
              subtext={
                connectionsCount['019cbaf2-d789-7723-aada-7e3d709663f5'] === 1
                  ? `1 Connection`
                  : connectionsCount['019cbaf2-d789-7723-aada-7e3d709663f5'] > 1
                    ? `${connectionsCount['019cbaf2-d789-7723-aada-7e3d709663f5']} Connections`
                    : undefined
              }
              className={
                connectionsCount['019cbaf2-d789-7723-aada-7e3d709663f5'] > 0 ? 'bg-green-200' : undefined
              }
            />
            <Card
              logo="/branding/steam/logo.svg"
              background="bg-slate-700"
              border="border-slate-600"
              text="Connect Steam to track your game library and achievements."
              onClick={() => navigate('/providers/019d6470-f9e1-720f-a3ce-299842abaece')}
              subtext={
                connectionsCount['019d6470-f9e1-720f-a3ce-299842abaece'] === 1
                  ? `1 Connection`
                  : connectionsCount['019d6470-f9e1-720f-a3ce-299842abaece'] > 1
                    ? `${connectionsCount['019d6470-f9e1-720f-a3ce-299842abaece']} Connections`
                    : undefined
              }
              className={
                connectionsCount['019d6470-f9e1-720f-a3ce-299842abaece'] > 0 ? 'bg-green-200' : undefined
              }
            />
            <Card
              logo="/branding/discord/logo.svg"
              background="bg-indigo-500"
              border="border-indigo-400"
              text="Connect Discord to sync your server activity, messages, and community interactions. Coming soon."
              disabled
            />
            <Card
              logo="/branding/github/logo.svg"
              background="bg-gray-800"
              border="border-gray-700"
              text="Link GitHub to track your code repositories, commits, and development activity. Coming soon."
              disabled
            />
            <Card
              logo="/branding/instagram/logo.svg"
              background="bg-pink-500"
              border="border-pink-400"
              text="Sync Instagram to capture your visual memories, stories, and social interactions. Coming soon."
              disabled
            />
            <Card
              logo="/branding/shopify/logo.svg"
              background="bg-green-600"
              border="border-green-500"
              text="Connect Shopify to track your e-commerce activity, orders, and business insights. Coming soon."
              disabled
            />
            <Card
              logo="/branding/signal/logo.svg"
              background="bg-blue-600"
              border="border-blue-500"
              text="Link Signal for secure messaging and communication tracking. Coming soon."
              disabled
            />
            <Card
              logo="/branding/slack/logo.svg"
              background="bg-purple-600"
              border="border-purple-500"
              text="Sync Slack to capture your team communications, channels, and workspace activity. Coming soon."
              disabled
            />
            <Card
              logo="/branding/x/logo.svg"
              background="bg-black"
              border="border-gray-600"
              text="Connect X to track your social interactions, posts, and real-time engagement streams. Coming soon."
              disabled
            />
            <Card
              logo="/branding/linkedin/logo.svg"
              background="bg-blue-600"
              border="border-blue-500"
              text="Link LinkedIn to track your professional network, career updates, and industry connections. Coming soon."
              disabled
            />
            <Card
              logo="/branding/notion/logo.svg"
              background="bg-gray-100"
              border="border-gray-300"
              text="Connect Notion to sync your notes, databases, and productivity workflows. Coming soon."
              disabled
            />
            <Card
              logo="/branding/twitch/logo.svg"
              background="bg-purple-500"
              border="border-purple-400"
              text="Link Twitch to track your streaming activity, follows, and gaming community engagement. Coming soon."
              disabled
            />
            <Card
              logo="/branding/reddit/logo.svg"
              background="bg-orange-500"
              border="border-orange-400"
              text="Connect Reddit to track your community discussions, posts, and subreddit interactions. Coming soon."
              disabled
            />
            <Card
              logo="/branding/dropbox/logo.svg"
              background="bg-blue-500"
              border="border-blue-400"
              text="Link Dropbox to sync your files, documents, and cloud storage activity. Coming soon."
              disabled
            />
          </div>
        </div>
      </PageContent>
    </>
  );
}
