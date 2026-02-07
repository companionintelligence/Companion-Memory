import { PROVIDER_CATALOG } from './definitions';
import type { ProviderCatalogEntry } from './types';

export interface ProviderConnectCardTheme {
  backgroundColor: string;
  borderColor: string;
}

export interface ProviderConnectCatalogEntry {
  key: string;
  providerId: string;
  displayName: string;
  lifecycle: ProviderCatalogEntry['lifecycle'];
  connectable: boolean;
  description: string;
  logoUrl: string;
  theme: ProviderConnectCardTheme;
}

interface ConnectCardMetadata {
  description: string;
  logoUrl: string;
  theme: ProviderConnectCardTheme;
}

const DEFAULT_CONNECT_CARD_THEME: ProviderConnectCardTheme = {
  backgroundColor: '#64748b',
  borderColor: '#94a3b8',
};

const PROVIDER_CONNECT_CARD_METADATA: Record<string, ConnectCardMetadata> = {
  microsoft: {
    description:
      'Bring your Microsoft account into the mix for email and scheduling. Keep track of what matters without extra steps.',
    logoUrl: '/branding/microsoft/logo.svg',
    theme: { backgroundColor: '#38bdf8', borderColor: '#7dd3fc' },
  },
  google: {
    description:
      'Link your Google account for quick access to Gmail, Calendar, Drive, Photos, and YouTube. Everything you need, always in sync.',
    logoUrl: '/branding/google/logo.svg',
    theme: { backgroundColor: '#a78bfa', borderColor: '#c4b5fd' },
  },
  facebook: {
    description:
      'Connect your Meta account to sync your Facebook posts, photos, videos, friends, and likes. Stay connected with your community.',
    logoUrl: '/branding/meta/logo.svg',
    theme: { backgroundColor: '#3b82f6', borderColor: '#60a5fa' },
  },
  discord: {
    description:
      'Connect Discord to sync your server activity, messages, and community interactions. Coming soon.',
    logoUrl: '/branding/discord/logo.svg',
    theme: { backgroundColor: '#6366f1', borderColor: '#818cf8' },
  },
  github: {
    description:
      'Link GitHub to track your code repositories, commits, and development activity. Coming soon.',
    logoUrl: '/branding/github/logo.svg',
    theme: { backgroundColor: '#1f2937', borderColor: '#374151' },
  },
  instagram: {
    description:
      'Sync Instagram to capture your visual memories, stories, and social interactions. Coming soon.',
    logoUrl: '/branding/instagram/logo.svg',
    theme: { backgroundColor: '#ec4899', borderColor: '#f472b6' },
  },
  shopify: {
    description:
      'Connect Shopify to track your e-commerce activity, orders, and business insights. Coming soon.',
    logoUrl: '/branding/shopify/logo.svg',
    theme: { backgroundColor: '#16a34a', borderColor: '#22c55e' },
  },
  signal: {
    description: 'Link Signal for secure messaging and communication tracking. Coming soon.',
    logoUrl: '/branding/signal/logo.svg',
    theme: { backgroundColor: '#2563eb', borderColor: '#3b82f6' },
  },
  slack: {
    description:
      'Sync Slack to capture your team communications, channels, and workspace activity. Coming soon.',
    logoUrl: '/branding/slack/logo.svg',
    theme: { backgroundColor: '#9333ea', borderColor: '#a855f7' },
  },
  spotify: {
    description:
      'Connect Spotify to track your music listening habits, playlists, and audio memories. Coming soon.',
    logoUrl: '/branding/spotify/logo.svg',
    theme: { backgroundColor: '#22c55e', borderColor: '#4ade80' },
  },
  steam: {
    description: 'Connect Steam to track your gaming activity, achievements, and game library. Coming soon.',
    logoUrl: '/branding/steam/logo.svg',
    theme: { backgroundColor: '#334155', borderColor: '#475569' },
  },
  x: {
    description:
      'Connect X to track your social interactions, posts, and real-time engagement streams. Coming soon.',
    logoUrl: '/branding/x/logo.svg',
    theme: { backgroundColor: '#000000', borderColor: '#4b5563' },
  },
  linkedin: {
    description:
      'Link LinkedIn to track your professional network, career updates, and industry connections. Coming soon.',
    logoUrl: '/branding/linkedin/logo.svg',
    theme: { backgroundColor: '#2563eb', borderColor: '#3b82f6' },
  },
  notion: {
    description: 'Connect Notion to sync your notes, databases, and productivity workflows. Coming soon.',
    logoUrl: '/branding/notion/logo.svg',
    theme: { backgroundColor: '#e5e7eb', borderColor: '#d1d5db' },
  },
  twitch: {
    description:
      'Link Twitch to track your streaming activity, follows, and gaming community engagement. Coming soon.',
    logoUrl: '/branding/twitch/logo.svg',
    theme: { backgroundColor: '#a855f7', borderColor: '#c084fc' },
  },
  reddit: {
    description:
      'Connect Reddit to track your community discussions, posts, and subreddit interactions. Coming soon.',
    logoUrl: '/branding/reddit/logo.svg',
    theme: { backgroundColor: '#f97316', borderColor: '#fb923c' },
  },
  dropbox: {
    description: 'Link Dropbox to sync your files, documents, and cloud storage activity. Coming soon.',
    logoUrl: '/branding/dropbox/logo.svg',
    theme: { backgroundColor: '#3b82f6', borderColor: '#60a5fa' },
  },
  evernote: {
    description: 'Connect Evernote to copy notes, notebooks, and document archives. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#16a34a', borderColor: '#22c55e' },
  },
  garmin: {
    description: 'Connect Garmin to sync activity, sleep, and wellness history. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#0891b2', borderColor: '#06b6d4' },
  },
  whoop: {
    description: 'Connect WHOOP to sync recovery, strain, and performance metrics. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#111827', borderColor: '#374151' },
  },
  fitbit: {
    description: 'Connect Fitbit to sync health activity, sleep, and heart-rate summaries. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#14b8a6', borderColor: '#2dd4bf' },
  },
  monday: {
    description: 'Connect monday.com to sync boards, items, and workflow updates. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#ef4444', borderColor: '#f87171' },
  },
  hubspot: {
    description: 'Connect HubSpot to sync contacts, deals, and CRM activities. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#f97316', borderColor: '#fb923c' },
  },
  jira: {
    description: 'Connect Jira to sync projects, issues, and worklogs. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#2563eb', borderColor: '#60a5fa' },
  },
  xero: {
    description: 'Connect Xero to sync invoices, contacts, and accounting events. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#0ea5e9', borderColor: '#38bdf8' },
  },
  quickbooks: {
    description: 'Connect QuickBooks to sync invoices, expenses, and financial documents. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#16a34a', borderColor: '#4ade80' },
  },
  box: {
    description: 'Connect Box to sync files, folders, and collaboration metadata. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#2563eb', borderColor: '#60a5fa' },
  },
  plaid: {
    description:
      'Connect Plaid to copy account and transaction history from linked institutions. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#7c3aed', borderColor: '#a78bfa' },
  },
  pinterest: {
    description: 'Connect Pinterest to sync your boards and pins. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#dc2626', borderColor: '#ef4444' },
  },
  lyft: {
    description: 'Connect Lyft to sync ride history and trip details. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#db2777', borderColor: '#f472b6' },
  },
  uber: {
    description: 'Connect Uber to sync ride history and travel activity. Coming soon.',
    logoUrl: '/logo.svg',
    theme: { backgroundColor: '#111827', borderColor: '#374151' },
  },
};

function buildDefaultMetadata(entry: ProviderCatalogEntry): ConnectCardMetadata {
  const suffix = entry.lifecycle === 'active' ? 'ready to connect now.' : 'coming soon.';

  return {
    description: `Connect ${entry.displayName} to sync your data and documents, ${suffix}`,
    logoUrl: '/logo.svg',
    theme: DEFAULT_CONNECT_CARD_THEME,
  };
}

export function listProviderConnectCatalog(
  isConnectable: (providerId: string) => boolean,
): ProviderConnectCatalogEntry[] {
  return PROVIDER_CATALOG.map((entry) => {
    const metadata = PROVIDER_CONNECT_CARD_METADATA[entry.key] ?? buildDefaultMetadata(entry);

    return {
      key: entry.key,
      providerId: entry.providerId,
      displayName: entry.displayName,
      lifecycle: entry.lifecycle,
      connectable: isConnectable(entry.providerId),
      description: metadata.description,
      logoUrl: metadata.logoUrl,
      theme: metadata.theme,
    };
  });
}
