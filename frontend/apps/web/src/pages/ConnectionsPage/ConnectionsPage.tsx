import { useState, useMemo } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID, Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Dialog, Card } from '@ci/shadcn';
import { AlertCircle, RefreshCw, Plus } from '@ci/shadcn/icons';
import { Link, useNavigate } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';

export interface Provider {
  readonly id: string;
  readonly name?: string | null;
  readonly endpoints: {
    name: string;
    description: string;
  }[];
  readonly providerKeys?: ProviderKeys | null;
}

export interface ProviderKeys {
  readonly id: string;
  readonly providerId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly userId: string;
}

export interface Connection {
  readonly id: string;
  readonly name?: string | null;
  readonly active: boolean;
  readonly externalId?: string | null;
  readonly schedule?: string | null;
  readonly tokenExpiry?: Date | null;
  readonly provider?: Provider;
  readonly activeEndpoints?: string[];
  readonly needsReauth: boolean;
  lastSyncedAt?: string;
}

const GET_CONNECTIONS = gql(`
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
          provider {
            id
            name
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

export function ConnectionsPage() {
  usePageTitle('Connections - Companion Intelligence');

  const navigate = useNavigate();

  const [showProviderModal, setShowProviderModal] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);
  const [providerConnections, setProviderConnections] = useState<Connection[]>([]);

  const {
    data: getConnections,
    loading: connectionsLoading,
    error: connectionsError,
  } = useQuery(GET_CONNECTIONS);

  const connections = getConnections?.connections.edges.map((edge) => edge.node) || [];

  // Group connections by provider
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
              <Breadcrumb.Page>Connections</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        <div className="flex flex-row items-center justify-between">
          <h1 className="text-2xl font-bold">Connections</h1>

          <Button variant="outline" size="icon" title="Create Connection" asChild>
            <Link to={'/connect'}>
              <Plus />
            </Link>
          </Button>
        </div>

        {connectionsLoading ? (
          <div className="text-center py-8">
            <RefreshCw className="h-8 w-8 animate-spin mx-auto" />
            <p>Loading...</p>
          </div>
        ) : connectionsError ? (
          <div className="bg-destructive/10 text-destructive rounded-md p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="font-medium">Error loading</h3>
              <p className="text-sm">{connectionsError.message}</p>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {providerGroups.map(({ provider, connections }) => {
                const hasReauthNeeded = connections.some((c) => c.needsReauth);

                return (
                  <Card
                    key={provider.id}
                    className="cursor-pointer hover:shadow-lg transition-shadow"
                    onClick={() => handleProviderClick(provider, connections)}
                  >
                    <Card.Content className="p-6 flex flex-col items-center gap-3">
                      <div className="text-lg font-semibold text-center">{provider.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {connections.length} {connections.length === 1 ? 'connection' : 'connections'}
                      </div>
                      {hasReauthNeeded && (
                        <div className="flex items-center gap-1 text-yellow-600 dark:text-yellow-500 text-xs">
                          <AlertCircle className="h-3 w-3" />
                          <span>Reauth needed</span>
                        </div>
                      )}
                    </Card.Content>
                  </Card>
                );
              })}
            </div>

            {providerGroups.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <p>No connections found. Create one to get started.</p>
              </div>
            )}

            <div className="text-xs text-muted-foreground mt-4">Total Connections: {connections.length}</div>
          </>
        )}
      </PageContent>

      {/* Provider Connections Modal */}
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
                className="cursor-pointer hover:bg-accent transition-colors"
                onClick={() => handleConnectionClick(connection.id)}
              >
                <Card.Content className="p-4 flex items-center justify-between">
                  <div className="flex flex-col gap-1">
                    <div
                      className={`font-medium ${connection.needsReauth ? 'text-yellow-600 dark:text-yellow-500' : ''}`}
                    >
                      {connection.name}
                    </div>
                    <div className="text-sm text-muted-foreground">{connection.externalId}</div>
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
    </>
  );
}
