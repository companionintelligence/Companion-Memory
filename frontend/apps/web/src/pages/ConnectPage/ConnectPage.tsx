import { useCallback, useEffect, useState } from 'react';

import { fetchJson, LoadingPage, Portal } from '@ci/common';
import { Breadcrumb, cn, useToast } from '@ci/shadcn';
import { useNavigate } from 'react-router-dom';

import { InlineModal } from '@/components/InlineModal';
import { PageContent } from '@/components/layout';
import { useAuth } from '@/hooks';

interface ConnectResponse {
  authorizationUrl: string;
}

type ReturnType = [
  {
    authorizationUrl: string | null;
    loading: boolean;
    error: unknown | null;
  },
  {
    connect: (providerId: string) => Promise<void>;
  },
];

function useConnectService(): ReturnType {
  const [{ authToken }] = useAuth();

  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<unknown | null>(null);

  const connect = useCallback(
    async (providerId: string) => {
      setAuthorizationUrl(null);
      setLoading(true);
      setError(null);

      try {
        const response = await fetchJson<ConnectResponse>(`/api/providers/${providerId}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
        });

        setAuthorizationUrl(response.authorizationUrl);
      } catch (err: unknown) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [authToken],
  );

  return [
    {
      authorizationUrl,
      loading,
      error,
    },
    {
      connect,
    },
  ];
}

export function ConnectPage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [{ authorizationUrl, loading, error }, { connect }] = useConnectService();

  useEffect(() => {
    if (!authorizationUrl) {
      return;
    }

    // We have to do `window.location` since this is an external URL.
    window.location.href = authorizationUrl;
  }, [authorizationUrl]);

  useEffect(() => {
    if (!error) {
      return;
    }

    toast.error('Error connecting to API');
    navigate(-1);
  }, [error]);

  return (
    <>
      <InlineModal open={loading || !!authorizationUrl}>
        <LoadingPage />
      </InlineModal>

      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link href="/">Companion</Breadcrumb.Link>
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
              onClick={() => connect('0198779b-3c33-73da-84e5-82e0df145260')}
            />
            <Card
              logo="/branding/google/logo.svg"
              background="bg-violet-400"
              border="border-violet-300"
              text="Link your Google account for quick access to Gmail, Calendar, Drive, Photos, and Youtube. Everything you need, always in sync."
              onClick={() => connect('0198779b-182c-716e-9275-b81d99a47fdb')}
            />
            <Card
              logo="/branding/meta/logo.svg"
              background="bg-blue-500"
              border="border-blue-400"
              text="Connect your Meta account to sync your Facebook posts, photos, videos, friends, and likes. Stay connected with your community."
              onClick={() => connect('dbb8002f-12da-4cd9-b02b-37db7791a900')}
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
              logo="/branding/spotify/logo.svg"
              background="bg-green-500"
              border="border-green-400"
              text="Connect Spotify to track your music listening habits, playlists, and audio memories. Coming soon."
              disabled
            />
            <Card
              logo="/branding/steam/logo.svg"
              background="bg-slate-700"
              border="border-slate-600"
              text="Connect Steam to track your gaming activity, achievements, and game library. Coming soon."
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

interface CardProps {
  background: string;
  border: string;
  logo: string;
  text: string;
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
}

function Card({ background, border, logo, text, disabled = false, onClick, className }: CardProps) {
  return (
    <div
      className={cn(
        'text-gray-700 dark:text-gray-200 rounded-lg bg-white shadow-md dark:bg-gray-800 dark:text-gray-200 select-none',
        onClick && !disabled ? 'cursor-pointer' : 'opacity-50',
        className,
      )}
      onClick={!disabled ? onClick : undefined}
    >
      <div className={cn('flex items-center justify-center p-10 rounded-t-lg', background)}>
        <div
          className={cn(
            'flex items-center justify-center p-6 rounded-full bg-white aspect-square border-6',
            border,
          )}
        >
          <img src={logo} className="w-12 h-12" />
        </div>
      </div>
      <div className="font-semibold text-sm p-6">{text}</div>
    </div>
  );
}
