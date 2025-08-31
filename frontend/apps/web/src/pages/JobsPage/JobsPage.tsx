import { useState, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { 
  Breadcrumb, 
  Button, 
  Card, 
  Badge, 
  Dialog, 
  Input, 
  Label, 
  Tabs,
  Table,
  Alert,
} from '@ci/shadcn';
import {
  CheckCircle,
  Plus,
  Edit,
  Trash2,
  RefreshCw,
  AlertCircle,
  X,
  Database,
  Activity,
  Timer,
  AlertTriangle,
  Clock,
} from '@ci/shadcn/icons';

import { PageContent } from '@/components/layout';
import { useJobsService, type JobInfo } from '@/api';

export function JobsPage() {
  usePageTitle('Jobs Queue - Companion Intelligence');

  const {
    jobs,
    stats,
    loading,
    error,
    fetchJobs,
    updateJobStatus,
    deleteJob,
    createJob,
  } = useJobsService();

  const [selectedJob, setSelectedJob] = useState<JobInfo | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Auto-refresh every 5 seconds for live view
  useEffect(() => {
    if (autoRefresh) {
      const interval = setInterval(() => {
        fetchJobs();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, fetchJobs]);

  const getStatusColor = (status: JobInfo['state']) => {
    switch (status) {
      case 'active':
        return 'bg-blue-500';
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      case 'retry':
        return 'bg-orange-500';
      case 'cancelled':
        return 'bg-gray-500';
      case 'expired':
        return 'bg-purple-500';
      default:
        return 'bg-yellow-500';
    }
  };

  const getStatusIcon = (status: JobInfo['state']) => {
    switch (status) {
      case 'active':
        return <Activity className="h-4 w-4" />;
      case 'completed':
        return <CheckCircle className="h-4 w-4" />;
      case 'failed':
        return <AlertCircle className="h-4 w-4" />;
      case 'retry':
        return <RefreshCw className="h-4 w-4" />;
      case 'cancelled':
        return <X className="h-4 w-4" />;
      case 'expired':
        return <Clock className="h-4 w-4" />;
      default:
        return <Timer className="h-4 w-4" />;
    }
  };

  const getFilteredJobs = (tab: string) => {
    if (tab === 'all') {
      return jobs;
    }
    return jobs.filter((job) => job.state === tab);
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  };

  const formatDuration = (start?: Date, end?: Date) => {
    if (!start) return 'N/A';
    const endTime = end || new Date();
    const duration = Math.floor((endTime.getTime() - start.getTime()) / 1000);
    
    if (duration < 60) return `${duration}s`;
    if (duration < 3600) return `${Math.floor(duration / 60)}m ${duration % 60}s`;
    return `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`;
  };

  const handleAction = async (jobId: string, action: 'complete' | 'fail' | 'delete') => {
    if (action === 'delete') {
      await deleteJob(jobId);
    } else {
      await updateJobStatus(jobId, action === 'complete' ? 'completed' : 'failed');
    }
  };

  const filteredJobs = getFilteredJobs(activeTab);

  if (loading && jobs.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4 text-blue-500" />
          <p className="text-muted-foreground">Loading job queue...</p>
        </div>
      </div>
    );
  }

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
              <Breadcrumb.Page>Jobs Queue</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {/* Header and Controls */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">PGBoss Job Queue</h1>
            <p className="text-muted-foreground mt-1">Live view of the task queue system</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={autoRefresh ? 'bg-green-50 border-green-200' : ''}
            >
              <Activity className={`h-4 w-4 mr-2 ${autoRefresh ? 'animate-pulse text-green-600' : ''}`} />
              {autoRefresh ? 'Live' : 'Paused'}
            </Button>
            <Button onClick={fetchJobs} variant="outline" size="sm">
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
            <Button onClick={createJob}>
              <Plus className="h-4 w-4 mr-2" />
              Test Job
            </Button>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <Alert className="mb-4 border-red-200 bg-red-50">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <Alert.Title className="text-red-800">Error</Alert.Title>
            <Alert.Description className="text-red-700">{error}</Alert.Description>
          </Alert>
        )}

        {/* Stats Overview */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-6">
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Database className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Total</p>
                <p className="text-2xl font-bold">{stats.total}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Activity className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Active</p>
                <p className="text-2xl font-bold text-blue-600">{stats.active}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-yellow-100 rounded-lg">
                <Timer className="h-4 w-4 text-yellow-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Created</p>
                <p className="text-2xl font-bold text-yellow-600">{stats.created}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <CheckCircle className="h-4 w-4 text-green-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Completed</p>
                <p className="text-2xl font-bold text-green-600">{stats.completed}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-red-100 rounded-lg">
                <AlertCircle className="h-4 w-4 text-red-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Failed</p>
                <p className="text-2xl font-bold text-red-600">{stats.failed}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-orange-100 rounded-lg">
                <RefreshCw className="h-4 w-4 text-orange-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Retry</p>
                <p className="text-2xl font-bold text-orange-600">{stats.retry}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-gray-100 rounded-lg">
                <X className="h-4 w-4 text-gray-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Cancelled</p>
                <p className="text-2xl font-bold text-gray-600">{stats.cancelled}</p>
              </div>
            </div>
          </Card>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <Tabs.List className="grid w-full grid-cols-6 mb-4">
            <Tabs.Trigger value="all" className="text-xs sm:text-sm">
              All ({jobs.length})
            </Tabs.Trigger>
            <Tabs.Trigger value="active" className="text-xs sm:text-sm">
              Active ({stats.active})
            </Tabs.Trigger>
            <Tabs.Trigger value="created" className="text-xs sm:text-sm">
              Created ({stats.created})
            </Tabs.Trigger>
            <Tabs.Trigger value="completed" className="text-xs sm:text-sm">
              Completed ({stats.completed})
            </Tabs.Trigger>
            <Tabs.Trigger value="failed" className="text-xs sm:text-sm">
              Failed ({stats.failed})
            </Tabs.Trigger>
            <Tabs.Trigger value="retry" className="text-xs sm:text-sm">
              Retry ({stats.retry})
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value={activeTab} className="mt-0">
            {filteredJobs.length === 0 ? (
              <div className="text-center py-12">
                <div className="space-y-4">
                  <Database className="h-12 w-12 mx-auto text-muted-foreground" />
                  <h3 className="text-lg font-semibold">No jobs found</h3>
                  <p className="text-muted-foreground max-w-sm mx-auto">
                    {activeTab === 'all'
                      ? "No jobs in the queue. Create a test job to see how it works."
                      : `No ${activeTab} jobs found. Try changing the tab or create a new job.`}
                  </p>
                  <Button onClick={createJob}>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Test Job
                  </Button>
                </div>
              </div>
            ) : (
              <Card>
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Job ID</Table.Head>
                      <Table.Head>Queue</Table.Head>
                      <Table.Head>Status</Table.Head>
                      <Table.Head>Data</Table.Head>
                      <Table.Head>Created</Table.Head>
                      <Table.Head>Started</Table.Head>
                      <Table.Head>Duration</Table.Head>
                      <Table.Head>Retries</Table.Head>
                      <Table.Head>Actions</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {filteredJobs.map((job) => (
                      <Table.Row key={job.id} className="hover:bg-muted/50">
                        <Table.Cell className="font-mono text-sm">{job.id}</Table.Cell>
                        <Table.Cell>
                          <Badge variant="outline">{job.name}</Badge>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex items-center space-x-2">
                            <div className={`p-1 rounded ${getStatusColor(job.state)} bg-opacity-20`}>
                              {getStatusIcon(job.state)}
                            </div>
                            <Badge className={`${getStatusColor(job.state)} text-white text-xs`}>
                              {job.state.toUpperCase()}
                            </Badge>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="max-w-xs">
                            <details className="cursor-pointer">
                              <summary className="text-sm text-muted-foreground hover:text-foreground">
                                {job.data?.name || 'View data...'}
                              </summary>
                              <pre className="text-xs mt-2 p-2 bg-muted rounded overflow-auto max-h-20">
                                {JSON.stringify(job.data, null, 2)}
                              </pre>
                            </details>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="text-sm text-muted-foreground">
                          {formatTime(job.createdOn)}
                        </Table.Cell>
                        <Table.Cell className="text-sm text-muted-foreground">
                          {job.startedOn ? formatTime(job.startedOn) : '-'}
                        </Table.Cell>
                        <Table.Cell className="text-sm text-muted-foreground">
                          {formatDuration(job.startedOn, job.completedOn)}
                        </Table.Cell>
                        <Table.Cell>
                          <span className="text-sm">
                            {job.retryCount || 0} / {job.retryLimit || 0}
                          </span>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex items-center space-x-2">
                            {job.state === 'active' && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleAction(job.id, 'complete')}
                                  className="text-green-600 hover:bg-green-50"
                                >
                                  <CheckCircle className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleAction(job.id, 'fail')}
                                  className="text-red-600 hover:bg-red-50"
                                >
                                  <AlertCircle className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => {
                                setSelectedJob(job);
                                setShowEditModal(true);
                              }}
                              className="text-blue-600 hover:bg-blue-50"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleAction(job.id, 'delete')}
                              className="text-red-600 hover:bg-red-50"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </Card>
            )}
          </Tabs.Content>
        </Tabs>
      </PageContent>

      {/* Job Details Modal */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <Dialog.Content className="sm:max-w-[600px]">
          <Dialog.Header>
            <Dialog.Title>Job Details</Dialog.Title>
            <Dialog.Description>View and manage job information from PGBoss</Dialog.Description>
          </Dialog.Header>

          {selectedJob && (
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Job ID</Label>
                  <Input value={selectedJob.id} readOnly className="font-mono" />
                </div>
                <div className="grid gap-2">
                  <Label>Queue Name</Label>
                  <Input value={selectedJob.name} readOnly />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Status</Label>
                  <div className="flex items-center space-x-2">
                    {getStatusIcon(selectedJob.state)}
                    <Badge className={`${getStatusColor(selectedJob.state)} text-white`}>
                      {selectedJob.state.toUpperCase()}
                    </Badge>
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label>Priority</Label>
                  <Input value={selectedJob.priority || 0} readOnly />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="grid gap-2">
                  <Label>Created</Label>
                  <Input value={formatTime(selectedJob.createdOn)} readOnly />
                </div>
                <div className="grid gap-2">
                  <Label>Started</Label>
                  <Input value={selectedJob.startedOn ? formatTime(selectedJob.startedOn) : 'Not started'} readOnly />
                </div>
                <div className="grid gap-2">
                  <Label>Duration</Label>
                  <Input value={formatDuration(selectedJob.startedOn, selectedJob.completedOn)} readOnly />
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Job Data</Label>
                <textarea
                  className="min-h-[100px] w-full p-3 border rounded-md bg-muted font-mono text-sm"
                  value={JSON.stringify(selectedJob.data, null, 2)}
                  readOnly
                />
              </div>

              {selectedJob.output && (
                <div className="grid gap-2">
                  <Label>Output</Label>
                  <textarea
                    className="min-h-[100px] w-full p-3 border rounded-md bg-muted font-mono text-sm"
                    value={JSON.stringify(selectedJob.output, null, 2)}
                    readOnly
                  />
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label>Retry Count</Label>
                  <Input value={`${selectedJob.retryCount || 0} / ${selectedJob.retryLimit || 0}`} readOnly />
                </div>
                <div className="grid gap-2">
                  <Label>Actions</Label>
                  <div className="flex space-x-2">
                    {selectedJob.state === 'active' && (
                      <>
                        <Button
                          size="sm"
                          onClick={() => {
                            handleAction(selectedJob.id, 'complete');
                            setShowEditModal(false);
                          }}
                          className="bg-green-600 hover:bg-green-700"
                        >
                          <CheckCircle className="h-4 w-4 mr-1" />
                          Complete
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            handleAction(selectedJob.id, 'fail');
                            setShowEditModal(false);
                          }}
                        >
                          <AlertCircle className="h-4 w-4 mr-1" />
                          Fail
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          <Dialog.Footer>
            <Button variant="outline" onClick={() => setShowEditModal(false)}>
              Close
            </Button>
            {selectedJob && (
              <Button
                variant="destructive"
                onClick={() => {
                  handleAction(selectedJob.id, 'delete');
                  setShowEditModal(false);
                }}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Job
              </Button>
            )}
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
