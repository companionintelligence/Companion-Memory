import { useState, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card, Table, Toggle, Dialog, Input, Label, Select } from '@ci/shadcn';
import { AlertCircle, RefreshCw, Settings, Trash2, Link2, X } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

export interface Provider {
  readonly id: string;
  readonly name: string | null;
}

export interface Connection {
  readonly id: string;
  readonly name: string | null;
  readonly active: boolean;
  readonly clientid: string | null;
  readonly clientkey: string | null;
  readonly clientsecret: string | null;
  readonly schedule: string | null;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly tokenExpiry: Date | null;
  readonly provider?: Provider;
}

export function ConnectionsPage() {
  usePageTitle('Connections - Companion Intelligence');

  const [{ authToken }] = useAuth();

  const [Providers, setProviders] = useState<Provider[]>([]);
  const [Connections, setConnections] = useState<Connection[]>([]);

  // const [changes, setChanges] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Modal state
  const [showConfigureModal, setShowConfigureModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<Connection | null>(null);
  const [configureFormData, setConfigureFormData] = useState({
    name: '',
    providerId: '',
    clientid: '',
    clientkey: '',
    clientsecret: '',
    schedule: 'daily',
  });
  const [configureLoading, setConfigureLoading] = useState(false);
  const [configureError, setConfigureError] = useState<string | null>(null);
  const [oauthInProgress, setOauthInProgress] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null);

  const fetchConnections = async () => {
    try {
      setLoading(true);
      setError(null);

      if (!authToken) {
        console.error('ConnectionsPage: No authentication token found');
        throw new Error('Authentication token not found');
      }

      console.log('ConnectionsPage: Making API request to /api/connections');
      const response = await fetch('/api/connections', {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        // Handle different HTTP error codes
        console.error(
          `ConnectionsPage: API request failed with status ${response.status}: ${response.statusText}`,
        );
        if (response.status === 401) {
          throw new Error('Unauthorized: You do not have permission to access this resource');
        } else if (response.status === 403) {
          throw new Error('Forbidden: Access denied');
        } else if (response.status === 404) {
          throw new Error('API endpoint not found');
        } else if (response.status >= 500) {
          throw new Error('Server error: Please try again later');
        } else {
          throw new Error(`Error fetching Connectors: ${response.statusText}`);
        }
      }

      console.log('ConnectionsPage: API request successful, parsing response');
      const data = await response.json();

      // Handle both array response and paginated response
      let ConnectionsData: Connection[] = [];
      if (Array.isArray(data)) {
        ConnectionsData = data;
      } else if (data.data && Array.isArray(data.data)) {
        ConnectionsData = data.data;
      } else {
        console.error('ConnectionsPage: Invalid response format', data);
        throw new Error('Invalid response format: Expected an array of Connectors');
      }

      console.log(`ConnectionsPage: Successfully fetched ${ConnectionsData.length} Connections`, {
        ConnectionsData,
      });
      setConnections(ConnectionsData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('ConnectionsPage: Error in fetchConnectors():', errorMessage, err);
      setError(errorMessage);
    } finally {
      console.log('ConnectionsPage: Fetch operation completed');
      setLoading(false);
    }
  };

  const fetchProviders = async () => {
    try {
      setLoading(true);
      setError(null);

      if (!authToken) {
        console.error('ConnectionsPage: No authentication token found');
        throw new Error('Authentication token not found');
      }

      console.log('ConnectionsPage: Making API request to /api/providers');
      const response = await fetch('/api/providers', {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        // Handle different HTTP error codes
        console.error(
          `ConnectionsPage: API request failed with status ${response.status}: ${response.statusText}`,
        );
        if (response.status === 401) {
          throw new Error('Unauthorized: You do not have permission to access this resource');
        } else if (response.status === 403) {
          throw new Error('Forbidden: Access denied');
        } else if (response.status === 404) {
          throw new Error('API endpoint not found');
        } else if (response.status >= 500) {
          throw new Error('Server error: Please try again later');
        } else {
          throw new Error(`Error fetching Connectors: ${response.statusText}`);
        }
      }

      console.log('ConnectionsPage: API request successful, parsing response');
      const data = await response.json();

      // Handle both array response and paginated response
      let ProvidersData: Provider[] = [];
      if (Array.isArray(data)) {
        ProvidersData = data;
      } else if (data.data && Array.isArray(data.data)) {
        ProvidersData = data.data;
      } else {
        console.error('ConnectionsPage: Invalid response format', data);
        throw new Error('Invalid response format: Expected an array of Connectors');
      }

      console.log(`ConnectionsPage: Successfully fetched ${ProvidersData.length} Connectors`, {
        ProvidersData,
      });
      setProviders(ProvidersData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('ConnectionsPage: Error in fetchConnectors():', errorMessage, err);
      setError(errorMessage);
    } finally {
      console.log('ConnectionsPage: Fetch operation completed');
      setLoading(false);
    }
  };

  const fetchState = async () => {
    await fetchConnections();
    await fetchProviders();
  };

  useEffect(() => {
    console.log('ConnectionsPage: Component mounted, fetching Connectors');

    // Check for OAuth callback
    const urlParams = new URLSearchParams(window.location.search);
    const oauthStatus = urlParams.get('oauth');
    const connectionId = urlParams.get('connectionId');
    const errorMessage = urlParams.get('message');

    if (oauthStatus === 'success' && connectionId) {
      setSuccessMessage(`Successfully authenticated connection!`);
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (oauthStatus === 'error') {
      setError(errorMessage || 'OAuth authentication failed');
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    fetchState();

    return () => {
      console.log('ConnectionsPage: Component unmounting');
    };
  }, []);

  const truncateText = (text: string | undefined, maxLength: number = 50) => {
    if (!text) {
      return 'N/A';
    }

    if (text.length <= maxLength) {
      return text;
    }

    return text.substring(0, maxLength) + '...';
  };

  const connectionToggle = (/* connection: Connection */) => {
    /*
    const c = connections.find(c => c.id === connector.id);
    if(c) {
        c.active = !c.active;
        setChanges(changes+1);
    }
    setConnectors(connections);
    */
  };

  const connectionConfigure = (connection: Connection) => {
    console.log('connection configure called - going to oauth url', connection);

    setSelectedConnection(connection);
    setConfigureFormData({
      name: connection.name || '',
      providerId: connection.provider?.id || '',
      clientid: connection.clientid || '',
      clientkey: connection.clientkey || '',
      clientsecret: connection.clientsecret || '',
      schedule: connection.schedule || 'daily',
    });
    setConfigureError(null);
    setShowConfigureModal(true);

    // Don't initiate OAuth automatically when opening the configure modal
    // Wait for user to save the configuration first
  };

  const connectionCreate = async () => {
    console.log('connection create called');

    try {
      if (!authToken) {
        throw new Error('Authentication token not found');
      }

      if (Providers.length === 0) {
        throw new Error('No providers available');
      }

      // Create a new connection with default values
      const defaultProvider = Providers.find((p) => p.name === 'google') || Providers[0];
      const response = await fetch('/api/connections', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'New Connection',
          providerId: defaultProvider.id,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error creating connection: ${response.statusText}`);
      }

      const newConnection = await response.json();
      console.log('Successfully created connection:', newConnection);

      // Refresh the connections list
      await fetchConnections();

      // Open configure modal for the new connection
      connectionConfigure(newConnection);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error creating connection:', errorMessage, err);
      setError(errorMessage);
    }
  };

  const handleConfigureSubmit = async () => {
    try {
      setConfigureLoading(true);
      setConfigureError(null);

      if (!authToken || !selectedConnection) {
        throw new Error('Authentication token or connection not found');
      }

      if (!configureFormData.name) {
        throw new Error('Name is required');
      }

      console.log('Updating connection with data:', configureFormData);

      const response = await fetch(`/api/connections/${selectedConnection.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: configureFormData.name,
          clientid: configureFormData.clientid,
          clientkey: configureFormData.clientkey,
          clientsecret: configureFormData.clientsecret,
          schedule: configureFormData.schedule,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error updating connection: ${response.statusText}`);
      }

      const updatedConnection = await response.json();
      console.log('Successfully updated connection:', updatedConnection);

      // Close modal and refresh the connections list
      setShowConfigureModal(false);
      await fetchConnections();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error updating connection:', errorMessage, err);
      setConfigureError(errorMessage);
    } finally {
      setConfigureLoading(false);
    }
  };

  const handleConnect = async (connection: Connection) => {
    if (!connection.clientid || !connection.clientsecret) {
      setError('Please configure OAuth credentials first');
      connectionConfigure(connection);

      return;
    }

    console.log('Initiating OAuth flow for connection', connection.id);
    setOauthInProgress(true);

    try {
      const response = await fetch(`/api/connections/${connection.id}/connect`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to get OAuth URL: ${response.statusText}`);
      }

      const data = await response.json();
      console.log('Got OAuth URL', data);

      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      console.error('Failed to initiate OAuth flow:', err);
      setError('Failed to start authentication process');
      setOauthInProgress(false);
    }
  };

  const handleDeleteConnection = async (connectionId: string) => {
    if (!confirm('Are you sure you want to delete this connection?')) {
      return;
    }

    try {
      setDeleteLoading(connectionId);

      if (!authToken) {
        throw new Error('Authentication token not found');
      }

      const response = await fetch(`/api/connections/${connectionId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error deleting connection: ${response.statusText}`);
      }

      // Refresh the connections list
      await fetchConnections();
      setSuccessMessage('Connection deleted successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error deleting connection:', errorMessage, err);
      setError(errorMessage);
    } finally {
      setDeleteLoading(null);
    }
  };

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Connections</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <Card className="w-full">
        <Card.Header className="flex flex-row items-center justify-between">
          <Card.Title className="text-2xl">Connections</Card.Title>
          <Button variant="outline" size="icon" disabled={loading} title="Refresh Providers">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            disabled={loading}
            onClick={connectionCreate}
            title="Create Connection"
          >
            Create
          </Button>
        </Card.Header>
        <Card.Content>
          {successMessage && (
            <div className="bg-green-50 text-green-800 rounded-md p-4 mb-4 flex items-start gap-3">
              <div>
                <p className="text-sm">{successMessage}</p>
              </div>
            </div>
          )}
          {loading || oauthInProgress ? (
            <div className="text-center py-8">
              <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4" />
              <p>{oauthInProgress ? 'Redirecting to authentication...' : 'Loading...'}</p>
            </div>
          ) : error ? (
            <div className="bg-destructive/10 text-destructive rounded-md p-4 flex items-start gap-3">
              <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-medium">Error loading</h3>
                <p className="text-sm">{error}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={fetchState()}>
                  Try Again
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <hr></hr>
                <h1>Connections</h1>
                <hr></hr>
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Name</Table.Head>
                      <Table.Head>Provider</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head>Schedule</Table.Head>
                      <Table.Head>Enabled</Table.Head>
                      <Table.Head>Actions</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {Providers.length === 0 ? (
                      <Table.Row>
                        <Table.Cell colSpan={7} className="text-center py-8 text-muted-foreground">
                          No Providers found in the system
                        </Table.Cell>
                      </Table.Row>
                    ) : (
                      Connections.map((connection) => (
                        <Table.Row key={connection.id}>
                          <Table.Cell className="text-sm">{connection.name}</Table.Cell>
                          <Table.Cell className="text-sm">{connection.provider?.name || 'N/A'}</Table.Cell>
                          <Table.Cell className="text-sm">
                            {connection.accessToken ? (
                              <span className="flex items-center gap-1 text-green-600">
                                <Link2 className="h-3 w-3" />
                                Connected
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-muted-foreground">
                                <X className="h-3 w-3" />
                                Not connected
                              </span>
                            )}
                          </Table.Cell>
                          <Table.Cell className="text-sm">{truncateText(connection.schedule)}</Table.Cell>
                          <Table.Cell className="text-sm">
                            <Toggle
                              aria-label="Toggle italic"
                              onClick={() => {
                                connectionToggle(connection);
                              }}
                            >
                              {connection.active ? 'enabled' : 'disabled'}
                            </Toggle>
                          </Table.Cell>
                          <Table.Cell className="text-sm">
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => connectionConfigure(connection)}
                                disabled={deleteLoading === connection.id || oauthInProgress}
                                title="Configure"
                              >
                                <Settings className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleConnect(connection)}
                                disabled={
                                  deleteLoading === connection.id ||
                                  oauthInProgress ||
                                  !connection.clientid ||
                                  !connection.clientsecret
                                }
                                title={
                                  !connection.clientid || !connection.clientsecret
                                    ? 'Configure OAuth credentials first'
                                    : connection.accessToken
                                      ? 'Reconnect'
                                      : 'Connect'
                                }
                              >
                                {connection.accessToken ? (
                                  <RefreshCw className="h-4 w-4" />
                                ) : (
                                  <Link2 className="h-4 w-4" />
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleDeleteConnection(connection.id)}
                                disabled={deleteLoading === connection.id || oauthInProgress}
                                title="Delete"
                              >
                                {deleteLoading === connection.id ? (
                                  <RefreshCw className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                              </Button>
                            </div>
                          </Table.Cell>
                        </Table.Row>
                      ))
                    )}
                  </Table.Body>
                </Table>
              </div>
              <div className="text-xs text-muted-foreground mt-4">
                Total Connections: {Connections.length}
              </div>
            </>
          )}
        </Card.Content>
      </Card>

      {/* Configure Connection Modal */}
      <Dialog open={showConfigureModal} onOpenChange={setShowConfigureModal}>
        <Dialog.Content className="sm:max-w-[500px]">
          <Dialog.Header>
            <Dialog.Title>Configure Connection</Dialog.Title>
            <Dialog.Description>Update the settings for this connection.</Dialog.Description>
          </Dialog.Header>

          <div className="grid gap-4 py-4">
            {configureError && (
              <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
                {configureError}
              </div>
            )}

            {selectedConnection?.accessToken && (
              <div className="bg-green-50 text-green-800 rounded-md p-3 text-sm flex items-center gap-2">
                <Link2 className="h-4 w-4" />
                This connection is authenticated. You can reconnect if needed.
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="name">Connection Name</Label>
              <Input
                id="name"
                placeholder="My Google Connection"
                value={configureFormData.name}
                onChange={(e) => setConfigureFormData({ ...configureFormData, name: e.target.value })}
                disabled={configureLoading}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="provider">Provider</Label>
              <Select
                value={configureFormData.providerId}
                onValueChange={(value) => setConfigureFormData({ ...configureFormData, providerId: value })}
                disabled={configureLoading}
              >
                <Select.Trigger id="provider">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {Providers.map((provider) => (
                    <Select.Item key={provider.id} value={provider.id}>
                      {provider.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="clientid">Client ID (Optional)</Label>
              <Input
                id="clientid"
                placeholder="your-client-id"
                value={configureFormData.clientid}
                onChange={(e) => setConfigureFormData({ ...configureFormData, clientid: e.target.value })}
                disabled={configureLoading}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="clientkey">Client Key (Optional)</Label>
              <Input
                id="clientkey"
                placeholder="your-client-key"
                value={configureFormData.clientkey}
                onChange={(e) => setConfigureFormData({ ...configureFormData, clientkey: e.target.value })}
                disabled={configureLoading}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="clientsecret">Client Secret (Optional)</Label>
              <Input
                id="clientsecret"
                type="password"
                placeholder="your-client-secret"
                value={configureFormData.clientsecret}
                onChange={(e) => setConfigureFormData({ ...configureFormData, clientsecret: e.target.value })}
                disabled={configureLoading}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="schedule">Sync Schedule</Label>
              <Select
                value={configureFormData.schedule}
                onValueChange={(value) => setConfigureFormData({ ...configureFormData, schedule: value })}
                disabled={configureLoading}
              >
                <Select.Trigger id="schedule">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="hourly">Hourly</Select.Item>
                  <Select.Item value="daily">Daily</Select.Item>
                  <Select.Item value="weekly">Weekly</Select.Item>
                </Select.Content>
              </Select>
            </div>
          </div>

          <Dialog.Footer>
            <Button
              variant="outline"
              onClick={() => setShowConfigureModal(false)}
              disabled={configureLoading}
            >
              Cancel
            </Button>
            <Button onClick={handleConfigureSubmit} disabled={configureLoading || !configureFormData.name}>
              {configureLoading ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
            {selectedConnection && configureFormData.clientid && configureFormData.clientsecret && (
              <Button
                variant="secondary"
                onClick={async () => {
                  // Save first if there are changes
                  if (
                    configureFormData.name !== selectedConnection.name ||
                    configureFormData.clientid !== selectedConnection.clientid ||
                    configureFormData.clientsecret !== selectedConnection.clientsecret ||
                    configureFormData.schedule !== selectedConnection.schedule
                  ) {
                    await handleConfigureSubmit();
                  }

                  setShowConfigureModal(false);
                  // Use the updated connection data
                  const updatedConnection = {
                    ...selectedConnection,
                    ...configureFormData,
                  };
                  handleConnect(updatedConnection);
                }}
                disabled={configureLoading}
              >
                {selectedConnection.accessToken ? 'Save & Reconnect' : 'Save & Connect'}
              </Button>
            )}
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
