import { useState, useMemo } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { Dialog, Card } from '@ci/shadcn';
import { AlertCircle, RefreshCw } from '@ci/shadcn/icons';
import { useNavigate } from 'react-router-dom';

import { gql } from '@/graphql';

export interface Provider {
  readonly id: string;
  readonly name?: string | null;
  readonly endpoints: {
    name: string;
    description: string;
  }[];
  readonly providerKeys?: ProviderKeys | null;
  readonly localOnly?: boolean;
  readonly appSetupUrl?: string;
}

export interface ProviderKeys {
  readonly id: string;
  readonly providerId: string;
  readonly clientId: string;
  readonly hasClientSecret: boolean;
  readonly clientSecretHint: string | null;
  readonly userId: string;
}

export interface Connection {
  readonly id: string;
  readonly name?: string | null;
  readonly active: boolean;
  readonly externalId?: string | null;
  readonly accountLabel?: string | null;
  readonly schedule?: string | null;
  readonly tokenExpiry?: Date | null;
  readonly provider?: Provider;
  readonly activeEndpoints?: string[];
  readonly needsReauth: boolean;
  lastSyncedAt?: string;
}

/**
 * Kept character-for-character as `/connections` sent it, so the codegen
 * document map and the Apollo cache entry are the same ones the app already
 * had — this section is a relocation of that page, not a new query.
 */
export const GET_CONNECTIONS = gql(`
  query GetConnections {
    connections {
      edges {
        cursor
        node {
          id
          name
          active
          schedule
          tokenExpiry
          syncState
          activeEndpoints
          providerId
          needsReauth
          externalId
          accountLabel
          provider {
            id
            name
            localOnly
            endpoints {
              name
              description
            }
          }
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

/**
 * The accounts already feeding this appliance, grouped by provider.
 *
 * This was the whole of `/connections`. It is a status list, not a
 * destination: it answers "what have I already done" and belongs directly
 * above the gallery of what you could add next, in the one place someone goes
 * to add more. Renders nothing at all when there is nothing connected — the
 * page's first-run tiles are the empty state, and a second "no connections
 * found" line under them would only repeat it.
 */
export function ConnectedAccountsSection() {
  const navigate = useNavigate();

  const [showProviderModal, setShowProviderModal] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [providerConnections, setProviderConnections] = useState<Connection[]>([]);

  const { data, loading, error } = useQuery(GET_CONNECTIONS);

  const connections = useMemo(
    () => data?.connections.edges.map((edge) => edge.node) ?? [],
    [data?.connections.edges],
  );

  const providerGroups = useMemo(() => {
    const groups = new Map<string, { provider: Provider; connections: Connection[] }>();

    connections.forEach((connection) => {
      if (connection.provider) {
        const providerId = connection.provider.id;
        if (!groups.has(providerId)) {
          groups.set(providerId, {
            provider: connection.provider,
            connections: [],
          });
        }

        groups.get(providerId)!.connections.push(connection);
      }
    });

    return Array.from(groups.values());
  }, [connections]);

  const handleProviderClick = (provider: Provider, connections: Connection[]) => {
    setSelectedProvider(provider);
    setProviderConnections(connections);
    setShowProviderModal(true);
  };

  const handleConnectionClick = (connectionId: string) => {
    navigate(`/connections/${GlobalUID.parse('connection', connectionId)}`);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <RefreshCw className="h-4 w-4 animate-spin" />
        <span>Loading your connected accounts…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive flex items-start gap-3 rounded-md p-4">
        <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0" />
        <div>
          <h3 className="font-medium">Could not load your connected accounts</h3>
          <p className="text-sm">{error.message}</p>
        </div>
      </div>
    );
  }

  if (providerGroups.length === 0) {
    return null;
  }

  const reauthCount = connections.filter((connection) => connection.needsReauth).length;

  return (
    <section className="mb-8 w-full">
      <h3 className="mb-3 text-lg font-semibold">
        Connected accounts
        {reauthCount > 0 && (
          <span className="ml-2 text-sm font-medium text-yellow-600 dark:text-yellow-500">
            {reauthCount === 1 ? 'one needs signing in again' : `${reauthCount} need signing in again`}
          </span>
        )}
      </h3>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {providerGroups.map(({ provider, connections }) => {
          const hasReauthNeeded = connections.some((c) => c.needsReauth);

          return (
            <Card
              key={provider.id}
              className="cursor-pointer transition-shadow hover:shadow-lg"
              onClick={() => handleProviderClick(provider, connections)}
            >
              <Card.Content className="flex flex-col items-center gap-3 p-6">
                <div className="text-center text-lg font-semibold">{provider.name}</div>
                <div className="text-muted-foreground text-sm">
                  {connections.length} {connections.length === 1 ? 'connection' : 'connections'}
                </div>
                {hasReauthNeeded && (
                  <div className="flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-500">
                    <AlertCircle className="h-3 w-3" />
                    <span>Reauth needed</span>
                  </div>
                )}
              </Card.Content>
            </Card>
          );
        })}
      </div>

      <Dialog open={showProviderModal} onOpenChange={setShowProviderModal}>
        <Dialog.Content className="sm:max-w-[500px] [&>button]:cursor-pointer">
          <Dialog.Header>
            <Dialog.Title>{selectedProvider?.name} Connections</Dialog.Title>
            <Dialog.Description>Select a connection to view details.</Dialog.Description>
          </Dialog.Header>

          <div className="flex flex-col gap-2 py-4">
            {providerConnections.map((connection) => (
              <Card
                key={connection.id}
                className="cursor-pointer transition-colors hover:bg-accent"
                onClick={() => handleConnectionClick(connection.id)}
              >
                <Card.Content className="flex items-center justify-between p-4">
                  <div className="flex flex-col gap-1">
                    <div
                      className={`font-medium ${connection.needsReauth ? 'text-yellow-600 dark:text-yellow-500' : ''}`}
                    >
                      {connection.accountLabel || connection.name || 'Connected account'}
                    </div>
                  </div>
                  {connection.needsReauth && (
                    <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-500" />
                  )}
                </Card.Content>
              </Card>
            ))}
          </div>
        </Dialog.Content>
      </Dialog>
    </section>
  );
}
