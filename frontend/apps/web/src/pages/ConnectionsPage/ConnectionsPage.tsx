import { useState, useCallback, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Table, Dialog, Input, Label, Select, useToast } from '@ci/shadcn';
import { AlertCircle, RefreshCw, Settings, Trash2, Plus } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

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

  const { toast } = useToast();

  const [{ authToken }] = useAuth();

  const [Connections, setConnections] = useState<Connection[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<Connection | null>(null);
  const [editFormData, setEditFormData] = useState({
    name: '',
    clientid: '',
    clientkey: '',
    clientsecret: '',
    schedule: 'daily',
  });
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
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

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const truncateText = (text: string | undefined, maxLength: number = 50) => {
    if (!text) {
      return 'N/A';
    }

    if (text.length <= maxLength) {
      return text;
    }

    return text.substring(0, maxLength) + '...';
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

      toast.success('Connection updated successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error updating connection:', errorMessage, err);
      setModalError(errorMessage);
    } finally {
      setModalLoading(false);
    }
  };

  const handleDeleteConnection = async (connectionId: string) => {
    if (
      !confirm(
        'Are you sure you want to delete this connection? Data from this connection will not be deleted.',
      )
    ) {
      return;
    }

    try {
      setDeleteLoading(connectionId);

      if (!authToken) {
        throw new Error('Authentication token not found');
      }

      const response = await fetch(`/api/connections/${connectionId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          active: false,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error deleting connection: ${response.statusText}`);
      }

      // Remove the connection from the local state
      setConnections((prevConnections) => prevConnections.filter((conn) => conn.id !== connectionId));

      toast.success('Connection deleted successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error deleting connection:', errorMessage, err);

      toast.error(errorMessage);
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

      toast.success(`Data synced successfully for connection: ${result.connection?.name || connectionId}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error syncing connection:', errorMessage, err);

      toast.error(errorMessage);
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
        <div className="flex flex-row items-center justify-between">
          <h1 className="text-2xl font-bold">Connections</h1>

          <Button variant="outline" size="icon" title="Create Connection" asChild>
            <Link to={'/connect'}>
              <Plus />
            </Link>
          </Button>
        </div>

        {loading ? (
          <div className="text-center py-8">
            <RefreshCw className="h-8 w-8 animate-spin mx-auto" />
            <p>Loading...</p>
          </div>
        ) : error ? (
          <div className="bg-destructive/10 text-destructive rounded-md p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="font-medium">Error loading</h3>
              <p className="text-sm">{error}</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => fetchConnections()}>
                Try Again
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Name</Table.Head>
                  <Table.Head>Provider</Table.Head>
                  <Table.Head>Schedule</Table.Head>
                  <Table.Head>Actions</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {Connections.map((connection) => (
                  <Table.Row key={connection.id}>
                    <Table.Cell className="text-sm">{connection.name}</Table.Cell>
                    <Table.Cell className="text-sm">{connection.provider?.name || 'N/A'}</Table.Cell>
                    <Table.Cell className="text-sm">{truncateText(connection.schedule ?? '')}</Table.Cell>
                    <Table.Cell className="text-sm">
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => connectionEdit(connection)}
                          disabled={deleteLoading === connection.id}
                          title="Edit"
                        >
                          <Settings className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDeleteConnection(connection.id)}
                          disabled={deleteLoading === connection.id}
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
                          disabled={deleteLoading === connection.id}
                          title="Sync Data"
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>

            <div className="text-xs text-muted-foreground">Total Connections: {Connections.length}</div>
          </>
        )}
      </PageContent>

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
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
