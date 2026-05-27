import { type ReactNode, useState } from 'react';

import { isReference, type Reference, useMutation, useQuery } from '@apollo/client';
import { GlobalUID, LoadingPage, Portal, usePageTitle, EmptyState } from '@ci/common';
import {
  Breadcrumb,
  Card,
  Label,
  Button,
  Dialog,
  Input,
  Select,
  useToast,
  Form,
  useForm,
  formDataResolver,
  formDataSchema as s,
} from '@ci/shadcn';
import { AlertCircle, Ban, CheckCircle2, Clock, RefreshCw, Settings, Trash2 } from '@ci/shadcn/icons';
import { useNavigate, useParams, Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { gql, makeFragmentData } from '@/graphql';
import { useAuth } from '@/hooks';
import { Endpoints, ENDPOINTS_FRAGMENT } from '@/pages/ProviderPage/Endpoints';
import { useConnectService } from '@/pages/ProviderPage/useConnectService';

export interface Provider {
  readonly id: string;
  readonly name?: string | null;
  readonly endpoints: {
    name: string;
    description: string;
    iterationType?: string[] | null;
    TTL?: number | null;
  }[];
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

export const EditConnectFormSchema = s.object({
  endpoints: s.array(s.string()).nullable().default(null),
});

export type EditConnectFormData = s.input<typeof EditConnectFormSchema>;

const GET_CONNECTION = gql(`
  query GetConnection($id: ID!) {
    connection(id: $id) {
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
        authType
        endpoints {
          name
          description
          iterationType
          TTL
        }
      }
    }
  }
`);

const UPDATE_CONNECTION = gql(`
  mutation UpdateConnection($input: UpdateConnectionInput!) {
    updateConnection(input: $input) {
      success
      connection {
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
              authType
              endpoints {
                name
                description
                iterationType
                TTL
              }
          }
      }
    }
  }
`);

const DELETE_CONNECTION = gql(`
  mutation DeleteConnection($input: DeleteByIdInput!) {
    deleteConnection(input: $input) {
      success
      deletedId
    }
  }
`);

const GET_CONNECTION_SYNC_JOBS = gql(`
  query GetConnectionSyncJobs($connectionId: ID!, $endpointName: String, $type: String, $first: Int) {
    connectionSyncJobs(connectionId: $connectionId, endpointName: $endpointName, type: $type, first: $first) {
      edges {
        cursor
        node {
          id
          cursor
          endpointName
          nextCursor
          connectionId
          status
          type
          createdAt
          updatedAt
          completedAt
          error
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

type StatusJob = {
  endpointName: string;
  status: string;
  type?: string | null;
  nextCursor?: unknown;
  completedAt?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  error?: { error?: string } | null;
};

function computeEndpointStatus(
  jobs: StatusJob[],
  endpoint: { name: string; TTL?: number | null },
  jobType: 'historical' | 'incremental' | null,
) {
  const endpointJobs = jobs
    .filter(
      (j) =>
        j.endpointName === endpoint.name && j.status !== 'pending' && (jobType == null || j.type === jobType),
    )
    .slice()
    .sort(
      (a, b) =>
        new Date(b.updatedAt ?? b.createdAt).getTime() - new Date(a.updatedAt ?? a.createdAt).getTime(),
    );

  const latest = endpointJobs[0];

  // Completion check: historical endpoint with no TTL whose latest job has an
  // empty nextCursor object means it has fully completed and will not be re-run.
  if (
    jobType === 'historical' &&
    endpoint.TTL == null &&
    latest &&
    typeof latest.nextCursor === 'object' &&
    latest.nextCursor !== null &&
    Object.keys(latest.nextCursor).length === 0
  ) {
    return {
      icon: <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500 flex-shrink-0" />,
      text: <span className="text-muted-foreground">Completed</span>,
    };
  }

  if (!latest) {
    return {
      icon: <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />,
      text: <span className="text-muted-foreground">Awaiting first run</span>,
    };
  }

  if (latest.status === 'success') {
    return {
      icon: <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500 flex-shrink-0" />,
      text: (
        <span className="text-muted-foreground">
          Successfully run at {new Date(latest.completedAt as string).toLocaleString()}
        </span>
      ),
    };
  }

  if (latest.status === 'in_progress') {
    return {
      icon: <RefreshCw className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-500 flex-shrink-0" />,
      text: <span className="text-muted-foreground">Run in progress</span>,
    };
  }

  if (latest.status === 'failed') {
    const errorText = latest.error?.error ?? 'Unknown error';

    return {
      icon: <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-500 flex-shrink-0" />,
      text: <span className="text-muted-foreground">Last run failed: {String(errorText)}</span>,
    };
  }

  return {
    icon: <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />,
    text: <span className="text-muted-foreground">Awaiting first run</span>,
  };
}

interface EndpointStatusRowProps {
  connectionId: string;
  endpoint: { name: string; TTL?: number | null };
  jobType: 'historical' | 'incremental' | null;
  label?: string;
}

/**
 * Renders a single status row for an endpoint. Each instance fetches its own
 * connectionSyncJobs scoped by endpointName (and type, when provided) so the
 * page does not need to load a global list of jobs up front.
 *
 * When `label` is provided, the row is rendered as an indented sub-row with
 * the label (used for "History" / "Ongoing" within a dual-iteration endpoint).
 * When `label` is undefined, the row is rendered as the top-level row with
 * the endpoint name as its label.
 */
function EndpointStatusRow({ connectionId, endpoint, jobType, label }: EndpointStatusRowProps) {
  const { data } = useQuery(GET_CONNECTION_SYNC_JOBS, {
    variables: {
      connectionId,
      endpointName: endpoint.name,
      type: jobType ?? undefined,
      first: 10,
    },
  });

  const jobs: StatusJob[] =
    (data?.connectionSyncJobs.edges.map((edge) => edge.node) as StatusJob[] | undefined) ?? [];

  const { icon, text } = computeEndpointStatus(jobs, endpoint, jobType);

  return (
    <li className="flex items-center gap-2 text-sm">
      {icon}
      <span className="font-medium">{label ?? endpoint.name}:</span>
      {text}
    </li>
  );
}

export function ConnectionPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [{ authToken }] = useAuth();

  const [showEditModal, setShowEditModal] = useState(false);
  const [editFormData, setEditFormData] = useState({
    name: '',
    schedule: '1 hour',
    accessToken: '',
  });
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const [{ endpoints, setEndpoints }] = useConnectService();

  const { data, loading } = useQuery(GET_CONNECTION, {
    variables: {
      id: GlobalUID.encode('connection', id!),
    },
  });

  const connection = data?.connection;

  const [updateConnection] = useMutation(UPDATE_CONNECTION);

  const [deleteConnection, { loading: deleteLoading }] = useMutation(DELETE_CONNECTION, {
    update(cache, { data }) {
      const deletedConnectionId = data?.deleteConnection?.deletedId;

      if (deletedConnectionId) {
        cache.modify({
          fields: {
            connections(
              existingConnections:
                | {
                    edges: { node: Reference }[];
                  }
                | Reference = { edges: [] },
              { readField },
            ) {
              if (isReference(existingConnections)) {
                return existingConnections;
              }

              return {
                ...existingConnections,
                edges: existingConnections.edges.filter((edge) => {
                  const edgeNodeId = readField('id', edge.node);

                  return edgeNodeId !== deletedConnectionId;
                }),
              };
            },
          },
        });

        const normalizedId = cache.identify({
          id: deletedConnectionId,
          __typename: 'ConnectionType',
        });

        if (normalizedId) {
          cache.evict({ id: normalizedId });
          cache.gc();
        }
      }
    },
  });

  const form = useForm<EditConnectFormData>({
    resolver: formDataResolver(EditConnectFormSchema),
    shouldUnregister: false,
  });

  usePageTitle(
    connection?.name
      ? `Connection - ${connection.name} - Companion Intelligence`
      : 'Connection - Companion Intelligence',
  );

  const handleEditSubmit = async () => {
    try {
      setModalLoading(true);
      setModalError(null);

      if (!authToken || !connection) {
        throw new Error('Authentication token or connection not found');
      }

      if (!editFormData.name) {
        throw new Error('Name is required');
      }

      await updateConnection({
        variables: {
          input: {
            id: connection.id,
            name: editFormData.name || '',
            schedule: editFormData.schedule || '1 hour',
            activeEndpoints: endpoints,
            ...(editFormData.accessToken ? { accessToken: editFormData.accessToken } : {}),
          },
        },
      });

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

  const handleDeleteConnection = async () => {
    if (
      !confirm(
        'Are you sure you want to delete this connection? Data from this connection will not be deleted.',
      )
    ) {
      return;
    }

    try {
      await deleteConnection({
        variables: {
          input: {
            id: connection!.id,
          },
        },
      });

      toast.success('Connection deleted successfully');
      navigate('/connections');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error deleting connection:', errorMessage, err);
      toast.error(errorMessage);
    }
  };

  const handleReauthConnection = async () => {
    try {
      const response = await fetch(
        `/api/connections/${GlobalUID.parse('connection', connection!.id)}/connect`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Error getting new auth URL: ${response.statusText}`);
      }

      const data = await response.json();
      window.location.href = data.url;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      console.error('Error reauthorizing connection:', errorMessage, err);
      toast.error(errorMessage);
    }
  };

  const connectionEdit = () => {
    if (connection) {
      setEditFormData({
        name: connection.name || '',
        schedule: connection.schedule || '1 hour',
        accessToken: '',
      });
      setModalError(null);
      setShowEditModal(true);
    }
  };

  let content: ReactNode | null = null;

  if (loading) {
    content = <LoadingPage />;
  } else if (connection == null) {
    content = <EmptyState icon={<Settings size={48} />} message="Connection not found" />;
  } else {
    content = (
      <PageContent>
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">{connection.name}</h1>
          <div className="flex gap-2">
            {connection.needsReauth && (
              <Button
                variant="outline"
                onClick={handleReauthConnection}
                className="text-yellow-600 dark:text-yellow-500 hover:text-yellow-700 dark:hover:text-yellow-400"
              >
                <AlertCircle className="h-4 w-4 mr-2" />
                Reauthorize Connection
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={connectionEdit}>
              <Settings className="h-4 w-4 mr-2" />
              Edit
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDeleteConnection} disabled={deleteLoading}>
              {deleteLoading ? (
                <RefreshCw className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              Delete
            </Button>
          </div>
        </div>

        <Card>
          <Card.Content className="p-6 flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Label>Provider</Label>
              <div className="text-sm">{connection.provider?.name || 'N/A'}</div>
            </div>

            <div className="flex flex-col gap-2">
              <Label>External ID</Label>
              <div className="text-sm">{connection.externalId || 'N/A'}</div>
            </div>

            {connection.provider?.endpoints && connection.provider.endpoints.length > 0 && (
              <div className="flex flex-col gap-2">
                <Label>Endpoints</Label>
                <ul className="flex flex-col gap-3">
                  {connection.provider.endpoints.map((endpoint) => {
                    const isActive = (connection.activeEndpoints || []).includes(endpoint.name);

                    if (!isActive) {
                      return (
                        <li key={endpoint.name} className="flex items-center gap-2 text-sm">
                          <Ban className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <span className="font-medium">{endpoint.name}:</span>
                          <span className="text-muted-foreground">Not enabled</span>
                        </li>
                      );
                    }

                    const iterationTypes = endpoint.iterationType || '';
                    const hasHistorical = iterationTypes.includes('historical');
                    const hasIncremental = iterationTypes.includes('incremental');
                    const showBoth = hasHistorical && hasIncremental;
                    const encodedConnectionId = GlobalUID.encode('connection', id!);

                    if (showBoth) {
                      return (
                        <li key={endpoint.name} className="flex flex-col gap-1 text-sm">
                          <span className="font-medium">{endpoint.name}</span>
                          <ul className="flex flex-col gap-1 pl-4">
                            <EndpointStatusRow
                              connectionId={encodedConnectionId}
                              endpoint={endpoint}
                              jobType="historical"
                              label="History"
                            />
                            <EndpointStatusRow
                              connectionId={encodedConnectionId}
                              endpoint={endpoint}
                              jobType="incremental"
                              label="Ongoing"
                            />
                          </ul>
                        </li>
                      );
                    }

                    // Only one iteration type (or unknown). When only historical is
                    // declared we still treat the jobs as historical so the completion
                    // check can apply when TTL is null.
                    const onlyType: 'historical' | 'incremental' | null = hasHistorical
                      ? 'historical'
                      : hasIncremental
                        ? 'incremental'
                        : null;

                    return (
                      <EndpointStatusRow
                        key={endpoint.name}
                        connectionId={encodedConnectionId}
                        endpoint={endpoint}
                        jobType={onlyType}
                      />
                    );
                  })}
                </ul>
              </div>
            )}

            {connection.needsReauth && (
              <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md p-4 flex items-start gap-3">
                <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0 text-yellow-600 dark:text-yellow-500" />
                <div>
                  <h3 className="font-medium text-yellow-900 dark:text-yellow-100">
                    Connection Needs Reauthorization
                  </h3>
                  <p className="text-sm text-yellow-800 dark:text-yellow-200">
                    This connection requires reauthorization to continue syncing data.
                  </p>
                </div>
              </div>
            )}
          </Card.Content>
        </Card>
      </PageContent>
    );
  }

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

            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/connections">Connections</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>

            {connection && (
              <>
                <Breadcrumb.Separator className="hidden md:block" />
                <Breadcrumb.Item>
                  <Breadcrumb.Page>{connection.name}</Breadcrumb.Page>
                </Breadcrumb.Item>
              </>
            )}
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      {content}

      {/* Edit Connection Modal */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <Dialog.Content className="sm:max-w-[500px]">
          <Dialog.Header>
            <Dialog.Title>Edit Connection</Dialog.Title>
            <Dialog.Description>Update the settings for this connection.</Dialog.Description>
          </Dialog.Header>

          <Form {...form}>
            <form className="relative flex flex-col gap-2">
              <div className="grid gap-4 py-4">
                {modalError && (
                  <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
                    {modalError}
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

                {connection?.provider && (
                  <div className="grid gap-2">
                    <Label>Provider</Label>
                    <div className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md">
                      {connection.provider.name} (cannot be changed)
                    </div>
                  </div>
                )}

                {connection?.externalId && (
                  <div className="grid gap-2">
                    <Label>External ID</Label>
                    <div className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md">
                      {connection.externalId} (cannot be changed)
                    </div>
                  </div>
                )}

                {connection?.provider?.authType === 'openid' && (
                  <div className="grid gap-2">
                    <Label htmlFor="edit-access-token">New OpenID API Key</Label>
                    <Input
                      id="edit-access-token"
                      type="password"
                      autoComplete="new-password"
                      placeholder="Leave blank to keep current key"
                      value={editFormData.accessToken}
                      onChange={(e) => setEditFormData({ ...editFormData, accessToken: e.target.value })}
                      disabled={modalLoading}
                    />
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
                      <Select.Item value="1 min">1 Minute</Select.Item>
                      <Select.Item value="5 min">5 Minutes</Select.Item>
                      <Select.Item value="10 min">10 Minutes</Select.Item>
                      <Select.Item value="30 min">30 Minutes</Select.Item>
                      <Select.Item value="1 hour">1 Hour</Select.Item>
                      <Select.Item value="2 hours">2 Hours</Select.Item>
                      <Select.Item value="6 hours">6 Hours</Select.Item>
                      <Select.Item value="12 hours">12 Hours</Select.Item>
                      <Select.Item value="daily">Daily</Select.Item>
                      <Select.Item value="weekly">Weekly</Select.Item>
                    </Select.Content>
                  </Select>
                </div>
              </div>

              {connection?.provider && (
                <>
                  <div className="grid gap-2">Endpoints</div>
                  <Endpoints
                    provider={makeFragmentData(connection.provider, ENDPOINTS_FRAGMENT)}
                    setEndpoints={setEndpoints}
                    startEndpoints={connection.activeEndpoints}
                  />
                </>
              )}

              <Dialog.Footer>
                <Button
                  variant="outline"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setShowEditModal(false);
                  }}
                  disabled={modalLoading}
                >
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
            </form>
          </Form>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
