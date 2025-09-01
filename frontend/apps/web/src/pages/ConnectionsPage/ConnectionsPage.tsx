import { useState, useEffect, useCallback } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Table, Toggle, Dialog, Input, Label, Select, Alert } from '@ci/shadcn';
import { AlertCircle, RefreshCw, Settings, Trash2, Link2, X, CheckCircle, Key, Database } from '@ci/shadcn/icons';

import { PageContent } from '@/components/layout';
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

  const connectionToggle = (connection: Connection) => {
    console.log('Toggling connection', connection);

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

      <PageContent>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Data Connections</h1>
            <p className="text-lg text-muted-foreground">
              Connect and manage your data sources for comprehensive tracking
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button 
              variant="outline" 
              size="icon" 
              disabled={loading} 
              onClick={() => fetchState()}
              title="Refresh connections and providers"
              className="shrink-0"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Button 
              disabled={loading} 
              onClick={connectionCreate} 
              title="Create a new data connection"
              className="shrink-0"
            >
              Create Connection
            </Button>
          </div>
        </div>

        {successMessage && (
          <Alert className="border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-400">
            <CheckCircle className="h-4 w-4" />
            <Alert.Title>Success</Alert.Title>
            <Alert.Description>{successMessage}</Alert.Description>
          </Alert>
        )}

        {loading || oauthInProgress ? (
          <div className="text-center py-8">
            <RefreshCw className="h-8 w-8 animate-spin mx-auto" />
            <p>{oauthInProgress ? 'Redirecting to authentication...' : 'Loading...'}</p>
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <Alert.Title>Failed to Load Connections</Alert.Title>
            <Alert.Description className="space-y-3">
              <p>{error}</p>
              <Button variant="outline" size="sm" onClick={() => fetchState()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Try Again
              </Button>
            </Alert.Description>
          </Alert>
        ) : (
          <>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head className="font-semibold">Connection Name</Table.Head>
                  <Table.Head className="font-semibold">Data Source</Table.Head>
                  <Table.Head className="font-semibold">Connection Status</Table.Head>
                  <Table.Head className="font-semibold">Sync Schedule</Table.Head>
                  <Table.Head className="font-semibold">Tracking Mode</Table.Head>
                  <Table.Head className="font-semibold text-right">Actions</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {Providers.length === 0 ? (
                  <Table.Row>
                    <Table.Cell colSpan={7} className="text-center py-12">
                      <div className="flex flex-col items-center gap-3 text-muted-foreground">
                        <Database className="h-12 w-12 opacity-50" />
                        <div>
                          <p className="font-medium">No Data Sources Available</p>
                          <p className="text-sm">Contact your administrator to set up data providers</p>
                        </div>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ) : Connections.length === 0 ? (
                  <Table.Row>
                    <Table.Cell colSpan={7} className="text-center py-12">
                      <div className="flex flex-col items-center gap-3 text-muted-foreground">
                        <Link2 className="h-12 w-12 opacity-50" />
                        <div>
                          <p className="font-medium">No Connections Configured</p>
                          <p className="text-sm">Create your first connection to start tracking data</p>
                        </div>
                        <Button onClick={connectionCreate} size="sm" className="mt-2">
                          Create Your First Connection
                        </Button>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ) : (
                  Connections.map((connection) => (
                    <Table.Row key={connection.id} className="hover:bg-muted/50">
                      <Table.Cell className="font-medium">
                        <div className="flex flex-col gap-1">
                          <span>{connection.name}</span>
                          {connection.lastSyncedAt && (
                            <span className="text-xs text-muted-foreground">
                              Last synced: {new Date(connection.lastSyncedAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-2 rounded-full bg-blue-500" />
                          <span className="font-medium">{connection.provider?.name || 'Unknown'}</span>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        {connection.accessToken ? (
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-2 rounded-full bg-green-500" />
                            <span className="text-green-700 dark:text-green-400 font-medium">
                              Connected & Active
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-2 rounded-full bg-orange-500" />
                            <span className="text-orange-700 dark:text-orange-400 font-medium">
                              Authentication Required
                            </span>
                          </div>
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex items-center gap-2">
                          <RefreshCw className="h-3 w-3 text-muted-foreground" />
                          <span className="capitalize">
                            {connection.schedule || 'Manual'}
                          </span>
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex items-center justify-between max-w-[120px]">
                          <span className={`text-sm font-medium ${connection.active ? 'text-green-700 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}`}>
                            {connection.active ? 'Domain Tracking' : 'Disabled'}
                          </span>
                          <Toggle
                            aria-label={`Toggle ${connection.active ? 'disable' : 'enable'} tracking for ${connection.name}`}
                            pressed={connection.active}
                            onPressedChange={() => connectionToggle(connection)}
                            size="sm"
                          />
                        </div>
                      </Table.Cell>
                      <Table.Cell>
                        <div className="flex gap-1 justify-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => connectionEdit(connection)}
                            disabled={deleteLoading === connection.id || oauthInProgress}
                            title="Configure connection settings"
                            className="h-8 w-8 p-0"
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
                                  ? 'Reconnect to refresh authentication'
                                  : 'Authenticate this connection'
                            }
                            className="h-8 w-8 p-0"
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
                            onClick={() => handleSyncConnection(connection.id)}
                            disabled={deleteLoading === connection.id || oauthInProgress}
                            title="Manually sync data from this connection"
                            className="h-8 w-8 p-0"
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDeleteConnection(connection.id)}
                            disabled={deleteLoading === connection.id || oauthInProgress}
                            title="Delete this connection permanently"
                            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
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

            <div className="flex items-center justify-between text-sm text-muted-foreground border-t pt-4 mt-6">
              <div className="flex items-center gap-4">
                <span>Total Connections: {Connections.length}</span>
                <span>Active: {Connections.filter(c => c.active).length}</span>
                <span>Connected: {Connections.filter(c => c.accessToken).length}</span>
              </div>
              <div className="text-xs">
                💡 Domain tracking monitors entire websites, page tracking focuses on specific URLs
              </div>
            </div>
          </>
        )}
      </PageContent>

      {/* Create Connection Modal */}
      <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
        <Dialog.Content className="sm:max-w-[600px]">
          <Dialog.Header>
            <Dialog.Title className="text-xl font-semibold">Create New Data Connection</Dialog.Title>
            <Dialog.Description className="text-base">
              Connect to a data source to track domain-wide activity or specific pages. 
              Domain tracking captures all activity across a website (e.g., all of www.youtube.com), 
              while page tracking focuses on specific URLs (e.g., www.youtube.com/watch?v=abc123).
            </Dialog.Description>
          </Dialog.Header>

          <div className="grid gap-6 py-6">
            {modalError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <Alert.Title>Error</Alert.Title>
                <Alert.Description>{modalError}</Alert.Description>
              </Alert>
            )}

            <div className="grid gap-3">
              <Label htmlFor="create-name" className="text-sm font-medium">
                Connection Display Name
              </Label>
              <Input
                id="create-name"
                placeholder="e.g., My YouTube Tracking, Work Gmail, Personal Calendar"
                value={createFormData.name}
                onChange={(e) => setCreateFormData({ ...createFormData, name: e.target.value })}
                disabled={modalLoading}
                className="text-base"
              />
              <p className="text-xs text-muted-foreground">
                Choose a descriptive name to help you identify this connection later
              </p>
            </div>

            <div className="grid gap-3">
              <Label htmlFor="create-provider" className="text-sm font-medium">
                Data Source Provider
              </Label>
              <Select
                value={createFormData.providerId}
                onValueChange={(value) => setCreateFormData({ ...createFormData, providerId: value })}
                disabled={modalLoading}
              >
                <Select.Trigger id="create-provider" className="text-base">
                  <Select.Value placeholder="Select a data source provider" />
                </Select.Trigger>
                <Select.Content>
                  {Providers.map((provider) => (
                    <Select.Item key={provider.id} value={provider.id} className="text-base">
                      {provider.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
              <p className="text-xs text-muted-foreground">
                The service you want to connect to for data tracking
              </p>
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
        <Dialog.Content className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <Dialog.Header>
            <Dialog.Title className="text-xl font-semibold">Configure Data Connection</Dialog.Title>
            <Dialog.Description className="text-base">
              Set up authentication and tracking preferences for this data source. 
              You can configure whether to track the entire domain or specific pages.
            </Dialog.Description>
          </Dialog.Header>

          <div className="grid gap-6 py-6">
            {modalError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <Alert.Title>Configuration Error</Alert.Title>
                <Alert.Description>{modalError}</Alert.Description>
              </Alert>
            )}

            {selectedConnection?.accessToken && (
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <Alert.Title>Connection Authenticated</Alert.Title>
                <Alert.Description>
                  This connection is successfully authenticated and ready to sync data. 
                  You can reconnect if needed to refresh the authentication.
                </Alert.Description>
              </Alert>
            )}

            <div className="grid gap-3">
              <Label htmlFor="edit-name" className="text-sm font-medium">
                Connection Display Name
              </Label>
              <Input
                id="edit-name"
                placeholder="e.g., My YouTube Domain Tracking, Work Gmail Pages"
                value={editFormData.name}
                onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
                disabled={modalLoading}
                className="text-base"
              />
              <p className="text-xs text-muted-foreground">
                A descriptive name to help identify this connection
              </p>
            </div>

            {selectedConnection?.provider && (
              <div className="grid gap-3">
                <Label className="text-sm font-medium">Data Source Provider</Label>
                <div className="flex items-center gap-3 bg-muted/50 px-4 py-3 rounded-lg">
                  <div className="h-3 w-3 rounded-full bg-blue-500" />
                  <span className="font-medium">{selectedConnection.provider.name}</span>
                  <span className="text-xs text-muted-foreground ml-auto">Cannot be changed</span>
                </div>
              </div>
            )}

            <div className="space-y-4 border-t pt-4">
              <div className="flex items-center gap-2">
                <Key className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">OAuth Authentication Settings</h3>
              </div>
              <p className="text-xs text-muted-foreground">
                Configure OAuth credentials to authenticate with the data source provider
              </p>

              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="edit-clientid" className="text-sm">
                    Application Client ID
                  </Label>
                  <Input
                    id="edit-clientid"
                    placeholder="your-app-client-id"
                    value={editFormData.clientid}
                    onChange={(e) => setEditFormData({ ...editFormData, clientid: e.target.value })}
                    disabled={modalLoading}
                    type="text"
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="edit-clientkey" className="text-sm">
                    Application Client Key <span className="text-xs text-muted-foreground">(if required)</span>
                  </Label>
                  <Input
                    id="edit-clientkey"
                    placeholder="your-app-client-key"
                    value={editFormData.clientkey}
                    onChange={(e) => setEditFormData({ ...editFormData, clientkey: e.target.value })}
                    disabled={modalLoading}
                    type="text"
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="edit-clientsecret" className="text-sm">
                    Application Client Secret
                  </Label>
                  <Input
                    id="edit-clientsecret"
                    type="password"
                    placeholder="your-app-client-secret"
                    value={editFormData.clientsecret}
                    onChange={(e) => setEditFormData({ ...editFormData, clientsecret: e.target.value })}
                    disabled={modalLoading}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-4 border-t pt-4">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-sm font-medium">Data Synchronization Settings</h3>
              </div>

              <div className="grid gap-3">
                <Label htmlFor="edit-schedule" className="text-sm font-medium">
                  Automatic Sync Frequency
                </Label>
                <Select
                  value={editFormData.schedule}
                  onValueChange={(value) => setEditFormData({ ...editFormData, schedule: value })}
                  disabled={modalLoading}
                >
                  <Select.Trigger id="edit-schedule" className="text-base">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="hourly">Every Hour - High frequency tracking</Select.Item>
                    <Select.Item value="daily">Daily - Standard tracking (recommended)</Select.Item>
                    <Select.Item value="weekly">Weekly - Light tracking for less active sources</Select.Item>
                  </Select.Content>
                </Select>
                <p className="text-xs text-muted-foreground">
                  How often to automatically sync new data from this source
                </p>
              </div>
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
