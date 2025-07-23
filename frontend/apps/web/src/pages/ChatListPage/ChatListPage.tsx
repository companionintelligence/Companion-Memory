import { useState, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card, Table } from '@ci/shadcn';
import { AlertCircle, Edit, Plus, RefreshCw, Trash2 } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { useAuth } from '@/hooks';

interface Thread {
  id: string;
  name: string | null;
  description: string | null;
}

export function ChatListPage() {
  usePageTitle('Threads - Companion Intelligence');

  const [{ authToken }] = useAuth();

  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchThreads = async () => {
    try {
      setLoading(true);
      setError(null);

      if (!authToken) {
        throw new Error('Authentication token not found');
      }

      const response = await fetch('/api/threads', {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Unauthorized: You do not have permission to access this resource');
        } else if (response.status === 403) {
          throw new Error('Forbidden: Access denied');
        } else if (response.status === 404) {
          throw new Error('API endpoint not found');
        } else if (response.status >= 500) {
          throw new Error('Server error: Please try again later');
        } else {
          throw new Error(`Error fetching threads: ${response.statusText}`);
        }
      }

      const data = await response.json();

      let threadsData: Thread[] = [];

      if (Array.isArray(data)) {
        threadsData = data;
      } else if (data.data && Array.isArray(data.data)) {
        threadsData = data.data;
      } else {
        throw new Error('Invalid response format: Expected an array of threads');
      }

      setThreads(threadsData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';

      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    const confirmed = window.confirm('Are you sure you want to delete this thread?');
    if (!confirmed) {
      return;
    }

    try {
      const res = await fetch(`/api/threads/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to delete thread ${id}`);
      }

      setThreads((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      console.error(err);
      alert('Failed to delete thread.');
    }
  };

  useEffect(() => {
    fetchThreads();
  }, []);

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
              <Breadcrumb.Page>Threads</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <Card className="w-full">
        <Card.Header className="flex flex-row items-center justify-between">
          <Card.Title className="text-2xl">Threads</Card.Title>
          <div className="flex flex-row items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={fetchThreads}
              disabled={loading}
              title="Refresh threads"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            <Link to={'/chat/new'}>
              <Button variant="outline" size="icon" title="New thread">
                <Plus className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </Card.Header>
        <Card.Content>
          {loading ? (
            <div className="text-center py-8">
              <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4" />
              <p>Loading threads...</p>
            </div>
          ) : error ? (
            <div className="bg-destructive/10 text-destructive rounded-md p-4 flex items-start gap-3">
              <AlertCircle className="h-5 w-5 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-medium">Error loading threads</h3>
                <p className="text-sm">{error}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={fetchThreads}>
                  Try Again
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>ID</Table.Head>
                      <Table.Head>Name</Table.Head>
                      <Table.Head>Description</Table.Head>
                      <Table.Head>Edit</Table.Head>
                      <Table.Head>Delete</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {threads.length === 0 ? (
                      <Table.Row>
                        <Table.Cell colSpan={7} className="text-center py-8 text-muted-foreground">
                          No threads found in the system
                        </Table.Cell>
                      </Table.Row>
                    ) : (
                      threads.map((thread) => (
                        <Table.Row key={thread.id}>
                          <Table.Cell className="font-mono text-xs">{thread.id}</Table.Cell>
                          <Table.Cell className="text-sm">{thread.name ?? 'N/A'}</Table.Cell>
                          <Table.Cell className="text-sm">{thread.description ?? 'N/A'}</Table.Cell>
                          <Table.Cell>
                            <Link to={`/chat/${thread.id}`}>
                              <Edit className="w-4 h-4" />
                            </Link>
                          </Table.Cell>
                          <Table.Cell>
                            <Button variant="ghost" onClick={() => handleDelete(thread.id)} className="group">
                              <Trash2 className="w-4 h-4 group-hover:text-destructive" />
                            </Button>
                          </Table.Cell>
                        </Table.Row>
                      ))
                    )}
                  </Table.Body>
                </Table>
              </div>
              <div className="text-xs text-muted-foreground mt-4">Total threads: {threads.length}</div>
            </>
          )}
        </Card.Content>
      </Card>
    </>
  );
}
