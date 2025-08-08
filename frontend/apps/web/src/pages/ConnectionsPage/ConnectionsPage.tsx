import { useState, useEffect, useCallback } from 'react';

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
  lastSyncedAt?: string;
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
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<Connection | null>(null);
  const [createFormData, setCreateFormData] = useState({
    name: '',
    providerId: '',
  });
  const [editFormData, setEditFormData] = useState({
    name: '',
    clientid: '',
    clientkey: '',
    clientsecret: '',
    schedule: 'daily',
  });
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [oauthInProgress, setOauthInProgress] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null);

  const fetchConnections = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      if (!authToken) {
        console.error('ConnectionsPage: No authentication token found');
        throw new Error('Authentication token not found');
      }

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
          throw new Error(`Error fetching connections: ${response.statusText}`);
        }
      }

      const data = await response.json();

      // Handle both array response and paginated response
      let ConnectionsData: Connection[] = [];
      if (Array.isArray(data)) {
        ConnectionsData = data;
      } else if (data.data && Array.isArray(data.data)) {
        ConnectionsData = data.data;
      } else {
        console.error('ConnectionsPage: Invalid response format', data);
        throw new Error('Invalid response format: Expected an array of connections');
      }

      setConnections(ConnectionsData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('ConnectionsPage: Error in fetchConnections():', errorMessage, err);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  const fetchProviders = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      if (!authToken) {
        console.error('ConnectionsPage: No authentication token found');
        throw new Error('Authentication token not found');
      }

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
          throw new Error(`Error fetching providers: ${response.statusText}`);
        }
      }

      const data = await response.json();

      // Handle both array response and paginated response
      let ProvidersData: Provider[] = [];
      if (Array.isArray(data)) {
        ProvidersData = data;
      } else if (data.data && Array.isArray(data.data)) {
        ProvidersData = data.data;
      } else {
        console.error('ConnectionsPage: Invalid response format', data);
        throw new Error('Invalid response format: Expected an array of providers');
      }

      setProviders(ProvidersData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('ConnectionsPage: Error in fetchProviders():', errorMessage, err);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  const fetchState = useCallback(async () => {
    await fetchConnections();
    await fetchProviders();
  }, [fetchConnections, fetchProviders]);

  useEffect(() => {
    // Check for OAuth callback
    const urlParams = new URLSearchParams(window.location.search);
    const oauthStatus = urlParams.get('oauth');
    const connectionId = urlParams.get('connectionId');
    const errorMessage = urlParams.get('message');

    if (oauthStatus === 'success' && connectionId) {
      // Make API call to complete the OAuth callback
      completeOAuthCallback(connectionId, true);
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    } else if (oauthStatus === 'error') {
      // Make API call to complete the OAuth callback with error
      const errorMsg = errorMessage || 'OAuth authentication failed';
      completeOAuthCallback(connectionId || '', false, errorMsg);
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    fetchState();
  }, [authToken, fetchState]);

  const completeOAuthCallback = useCallback(
    async (connectionId: string, success: boolean, error?: string) => {
      try {
        if (!authToken) {
          throw new Error('Authentication token not found');
        }

        const response = await fetch('/api/connections/callback/complete', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            connectionId,
            success,
            error,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || `Error completing OAuth callback: ${response.statusText}`);
        }

        const result = await response.json();

        if (result.success) {
          setSuccessMessage(
            `Successfully authenticated connection: ${result.connection?.name || connectionId}`,
          );
          // Update the connection in the local state if we have the updated data
          if (result.connection) {
            setConnections((prevConnections) =>
              prevConnections.map((conn) => (conn.id === connectionId ? result.connection : conn)),
            );
          } else {
            // Only fetch if we don't have the updated connection data
            await fetchConnections();
          }
        } else {
          setError(result.error || 'OAuth authentication failed');
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
        console.error('Error completing OAuth callback:', errorMessage, err);
        setError(errorMessage);
      }
    },
    [authToken, fetchConnections],
  );

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

  const connectionEdit = (connection: Connection) => {
    console.log('connection edit called', connection);
    setSelectedConnection(connection);
    setEditFormData({
      name: connection.name || '',
      clientid: connection.clientid || '',
      clientkey: connection.clientkey || '',
      clientsecret: connection.clientsecret || '',
      schedule: connection.schedule || 'daily',
    });
    setModalError(null);
    setShowEditModal(true);
  };

  const connectionCreate = () => {
    console.log('connection create called');

    if (Providers.length === 0) {
      setError('No providers available. Please add providers first.');

      return;
    }

    // Reset form and open create modal
    setCreateFormData({
      name: '',
      providerId: Providers[0].id,
    });
    setModalError(null);
    setShowCreateModal(true);
  };

  const handleCreateSubmit = async () => {
    try {
      setModalLoading(true);
      setModalError(null);

      if (!authToken) {
        throw new Error('Authentication token not found');
      }

      if (!createFormData.name) {
        throw new Error('Name is required');
      }

      if (!createFormData.providerId) {
        throw new Error('Provider is required');
      }

      console.log('Creating connection with data:', createFormData);

      const response = await fetch('/api/connections', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: createFormData.name,
          providerId: createFormData.providerId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error creating connection: ${response.statusText}`);
      }

      const newConnection = await response.json();
      console.log('Successfully created connection:', newConnection);

      // Add the new connection to the local state
      setConnections((prevConnections) => [...prevConnections, newConnection]);

      // Close modal
      setShowCreateModal(false);
      setSuccessMessage('Connection created successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error creating connection:', errorMessage, err);
      setModalError(errorMessage);
    } finally {
      setModalLoading(false);
    }
  };

  const handleEditSubmit = async () => {
    try {
      setModalLoading(true);
      setModalError(null);

      if (!authToken || !selectedConnection) {
        throw new Error('Authentication token or connection not found');
      }

      if (!editFormData.name) {
        throw new Error('Name is required');
      }

      console.log('Updating connection with data:', editFormData);

      const response = await fetch(`/api/connections/${selectedConnection.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: editFormData.name,
          clientid: editFormData.clientid,
          clientkey: editFormData.clientkey,
          clientsecret: editFormData.clientsecret,
          schedule: editFormData.schedule,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error updating connection: ${response.statusText}`);
      }

      const updatedConnection = await response.json();
      console.log('Successfully updated connection:', updatedConnection);

      // Update the connection in the local state
      setConnections((prevConnections) =>
        prevConnections.map((conn) => (conn.id === updatedConnection.id ? updatedConnection : conn)),
      );

      // Close modal
      setShowEditModal(false);
      setSuccessMessage('Connection updated successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error updating connection:', errorMessage, err);
      setModalError(errorMessage);
    } finally {
      setModalLoading(false);
    }
  };

  const handleConnect = async (connection: Connection) => {
    if (!connection.clientid || !connection.clientsecret) {
      setError('Please configure OAuth credentials first');
      connectionEdit(connection);

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

      // Remove the connection from the local state
      setConnections((prevConnections) => prevConnections.filter((conn) => conn.id !== connectionId));
      setSuccessMessage('Connection deleted successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error deleting connection:', errorMessage, err);
      setError(errorMessage);
    } finally {
      setDeleteLoading(null);
    }
  };

  const handleSyncConnection = async (connectionId: string) => {
    if (!confirm('Are you sure you want to sync data for this connection?')) {
      return;
    }

    try {
      setDeleteLoading(connectionId);

      if (!authToken) {
        throw new Error('Authentication token not found');
      }

      const response = await fetch(`/api/connections/${connectionId}/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error syncing connection: ${response.statusText}`);
      }

      const result = await response.json();
      console.log('Successfully synced connection:', result);

      // Update the connection's last sync time in the local state
      setConnections((prevConnections) =>
        prevConnections.map((conn) =>
          conn.id === connectionId ? { ...conn, lastSyncedAt: new Date().toISOString() } : conn,
        ),
      );

      setSuccessMessage(
        `Data synced successfully for connection: ${result.connection?.name || connectionId}`,
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error syncing connection:', errorMessage, err);
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
                                onClick={() => connectionEdit(connection)}
                                disabled={deleteLoading === connection.id || oauthInProgress}
                                title="Edit"
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
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handleSyncConnection(connection.id)}
                                disabled={deleteLoading === connection.id || oauthInProgress}
                                title="Sync Data"
                              >
                                <RefreshCw className="h-4 w-4" />
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

      {/* Create Connection Modal */}
      <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
        <Dialog.Content className="sm:max-w-[500px]">
          <Dialog.Header>
            <Dialog.Title>Create Connection</Dialog.Title>
            <Dialog.Description>Create a new connection to a provider.</Dialog.Description>
          </Dialog.Header>

          <div className="grid gap-4 py-4">
            {modalError && (
              <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{modalError}</div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="create-name">Connection Name</Label>
              <Input
                id="create-name"
                placeholder="My Google Connection"
                value={createFormData.name}
                onChange={(e) => setCreateFormData({ ...createFormData, name: e.target.value })}
                disabled={modalLoading}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="create-provider">Provider</Label>
              <Select
                value={createFormData.providerId}
                onValueChange={(value) => setCreateFormData({ ...createFormData, providerId: value })}
                disabled={modalLoading}
              >
                <Select.Trigger id="create-provider">
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
          </div>

          <Dialog.Footer>
            <Button variant="outline" onClick={() => setShowCreateModal(false)} disabled={modalLoading}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateSubmit}
              disabled={modalLoading || !createFormData.name || !createFormData.providerId}
            >
              {modalLoading ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                  Creating...
                </>
              ) : (
                'Create'
              )}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      {/* Edit Connection Modal */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <Dialog.Content className="sm:max-w-[500px]">
          <Dialog.Header>
            <Dialog.Title>Edit Connection</Dialog.Title>
            <Dialog.Description>Update the settings for this connection.</Dialog.Description>
          </Dialog.Header>

          <div className="grid gap-4 py-4">
            {modalError && (
              <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{modalError}</div>
            )}

            {selectedConnection?.accessToken && (
              <div className="bg-green-50 text-green-800 rounded-md p-3 text-sm flex items-center gap-2">
                <Link2 className="h-4 w-4" />
                This connection is authenticated. You can reconnect if needed.
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="edit-name">Connection Name</Label>
              <Input
                id="edit-name"
                placeholder="My Google Connection"
                value={editFormData.name}
                onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
                disabled={modalLoading}
              />
            </div>

            {selectedConnection?.provider && (
              <div className="grid gap-2">
                <Label>Provider</Label>
                <div className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md">
                  {selectedConnection.provider.name} (cannot be changed)
                </div>
              </div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="edit-clientid">Client ID (Optional)</Label>
              <Input
                id="edit-clientid"
                placeholder="your-client-id"
                value={editFormData.clientid}
                onChange={(e) => setEditFormData({ ...editFormData, clientid: e.target.value })}
                disabled={modalLoading}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="edit-clientkey">Client Key (Optional)</Label>
              <Input
                id="edit-clientkey"
                placeholder="your-client-key"
                value={editFormData.clientkey}
                onChange={(e) => setEditFormData({ ...editFormData, clientkey: e.target.value })}
                disabled={modalLoading}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="edit-clientsecret">Client Secret (Optional)</Label>
              <Input
                id="edit-clientsecret"
                type="password"
                placeholder="your-client-secret"
                value={editFormData.clientsecret}
                onChange={(e) => setEditFormData({ ...editFormData, clientsecret: e.target.value })}
                disabled={modalLoading}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="edit-schedule">Sync Schedule</Label>
              <Select
                value={editFormData.schedule}
                onValueChange={(value) => setEditFormData({ ...editFormData, schedule: value })}
                disabled={modalLoading}
              >
                <Select.Trigger id="edit-schedule">
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
            <Button variant="outline" onClick={() => setShowEditModal(false)} disabled={modalLoading}>
              Cancel
            </Button>
            <Button onClick={handleEditSubmit} disabled={modalLoading || !editFormData.name}>
              {modalLoading ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
            {selectedConnection && editFormData.clientid && editFormData.clientsecret && (
              <Button
                variant="secondary"
                onClick={async () => {
                  console.log('handleConnect clicked', {
                    editFormData,
                    selectedConnection,
                  });
                  // Save first if there are changes
                  if (
                    editFormData.name !== selectedConnection.name ||
                    editFormData.clientid !== selectedConnection.clientid ||
                    editFormData.clientsecret !== selectedConnection.clientsecret ||
                    editFormData.schedule !== selectedConnection.schedule
                  ) {
                    await handleEditSubmit();
                  }

                  setShowEditModal(false);
                  // Use the updated connection data
                  const updatedConnection = {
                    ...selectedConnection,
                    ...editFormData,
                  };
                  handleConnect(updatedConnection);
                }}
                disabled={modalLoading}
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
