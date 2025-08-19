import React, { useState, useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Card, Badge, Dialog, Input, Label, Select, Progress, Tabs } from '@ci/shadcn';
import {
  Clock,
  Play,
  Pause,
  CheckCircle,
  Calendar,
  Plus,
  Edit,
  Trash2,
  RefreshCw,
  Zap,
  CalendarDays,
  Timer,
  Target,
  Users,
  FileText,
  ShoppingCart,
  BookOpen,
  Dumbbell,
  Music,
  Plane,
  Briefcase,
  Filter,
} from '@ci/shadcn/icons';

export interface Job {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'scheduled';
  readonly priority: 'low' | 'medium' | 'high' | 'urgent';
  readonly category: 'personal' | 'work' | 'health' | 'learning' | 'entertainment' | 'travel' | 'shopping';
  readonly scheduledFor?: Date;
  readonly estimatedDuration: number; // in minutes
  readonly progress?: number; // 0-100
  readonly icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  readonly color: string;
  readonly tags: string[];
  readonly recurring?: {
    frequency: 'daily' | 'weekly' | 'monthly';
    nextOccurrence: Date;
  };
}

export function JobsPage() {
  usePageTitle('Jobs Queue - Companion Intelligence');

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [activeTab, setActiveTab] = useState('all');
  const [sortBy, setSortBy] = useState<'priority' | 'time' | 'category'>('priority');

  // Fake demo data
  const demoJobs: Job[] = [
    {
      id: '1',
      title: 'Morning Workout',
      description: 'Complete 30-minute HIIT session with strength training',
      status: 'running',
      priority: 'high',
      category: 'health',
      estimatedDuration: 30,
      progress: 65,
      icon: Dumbbell,
      color: 'bg-blue-500',
      tags: ['fitness', 'morning-routine'],
      recurring: {
        frequency: 'daily',
        nextOccurrence: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    },
    {
      id: '2',
      title: 'Review Project Proposal',
      description: 'Analyze Q4 marketing strategy and provide feedback',
      status: 'pending',
      priority: 'urgent',
      category: 'work',
      scheduledFor: new Date(Date.now() + 2 * 60 * 60 * 1000),
      estimatedDuration: 45,
      icon: Briefcase,
      color: 'bg-purple-500',
      tags: ['work', 'review', 'deadline'],
    },
    {
      id: '3',
      title: 'Grocery Shopping',
      description: 'Buy ingredients for weekly meal prep',
      status: 'scheduled',
      priority: 'medium',
      category: 'shopping',
      scheduledFor: new Date(Date.now() + 4 * 60 * 60 * 1000),
      estimatedDuration: 60,
      icon: ShoppingCart,
      color: 'bg-green-500',
      tags: ['shopping', 'meal-prep'],
    },
    {
      id: '4',
      title: 'Read Design Patterns Book',
      description: 'Continue reading Chapter 5: Factory Pattern',
      status: 'pending',
      priority: 'low',
      category: 'learning',
      estimatedDuration: 30,
      icon: BookOpen,
      color: 'bg-orange-500',
      tags: ['learning', 'programming', 'design-patterns'],
    },
    {
      id: '5',
      title: 'Call Mom',
      description: 'Weekly check-in call',
      status: 'scheduled',
      priority: 'high',
      category: 'personal',
      scheduledFor: new Date(Date.now() + 6 * 60 * 60 * 1000),
      estimatedDuration: 20,
      icon: Users,
      color: 'bg-pink-500',
      tags: ['family', 'personal'],
    },
    {
      id: '6',
      title: 'Plan Weekend Trip',
      description: 'Research hotels and activities for upcoming vacation',
      status: 'pending',
      priority: 'medium',
      category: 'travel',
      estimatedDuration: 90,
      icon: Plane,
      color: 'bg-cyan-500',
      tags: ['travel', 'planning', 'vacation'],
    },
    {
      id: '7',
      title: 'Practice Guitar',
      description: 'Work on new chord progressions for 20 minutes',
      status: 'completed',
      priority: 'low',
      category: 'entertainment',
      estimatedDuration: 20,
      progress: 100,
      icon: Music,
      color: 'bg-yellow-500',
      tags: ['music', 'hobby', 'practice'],
    },
    {
      id: '8',
      title: 'Update Portfolio',
      description: 'Add recent projects and update skills section',
      status: 'failed',
      priority: 'medium',
      category: 'work',
      estimatedDuration: 60,
      icon: FileText,
      color: 'bg-red-500',
      tags: ['portfolio', 'career', 'update'],
    },
  ];

  useEffect(() => {
    // Simulate loading
    setTimeout(() => {
      setJobs(demoJobs);
      setLoading(false);
    }, 1000);
  }, []);

  const getStatusColor = (status: Job['status']) => {
    switch (status) {
      case 'running':
        return 'bg-blue-500';
      case 'completed':
        return 'bg-green-500';
      case 'failed':
        return 'bg-red-500';
      case 'scheduled':
        return 'bg-purple-500';
      default:
        return 'bg-gray-500';
    }
  };

  const getPriorityColor = (priority: Job['priority']) => {
    switch (priority) {
      case 'urgent':
        return 'bg-red-500';
      case 'high':
        return 'bg-orange-500';
      case 'medium':
        return 'bg-yellow-500';
      default:
        return 'bg-gray-500';
    }
  };

  const getPriorityText = (priority: Job['priority']) => {
    switch (priority) {
      case 'urgent':
        return 'Urgent';
      case 'high':
        return 'High';
      case 'medium':
        return 'Medium';
      default:
        return 'Low';
    }
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  };

  const getFilteredJobs = (tab: string) => {
    if (tab === 'all') {
      return jobs;
    }

    return jobs.filter((job) => job.status === tab);
  };

  const sortedJobs = [...getFilteredJobs(activeTab)].sort((a, b) => {
    switch (sortBy) {
      case 'priority': {
        const priorityOrder = { urgent: 4, high: 3, medium: 2, low: 1 };

        return priorityOrder[b.priority] - priorityOrder[a.priority];
      }

      case 'time':
        if (a.scheduledFor && b.scheduledFor) {
          return a.scheduledFor.getTime() - b.scheduledFor.getTime();
        }

        return 0;
      case 'category':
        return a.category.localeCompare(b.category);
      default:
        return 0;
    }
  });

  const stats = {
    total: jobs.length,
    running: jobs.filter((j) => j.status === 'running').length,
    pending: jobs.filter((j) => j.status === 'pending').length,
    completed: jobs.filter((j) => j.status === 'completed').length,
    scheduled: jobs.filter((j) => j.status === 'scheduled').length,
  };

  const handleStartJob = (jobId: string) => {
    setJobs((prev) =>
      prev.map((job) => (job.id === jobId ? { ...job, status: 'running' as const, progress: 0 } : job)),
    );
  };

  const handlePauseJob = (jobId: string) => {
    setJobs((prev) => prev.map((job) => (job.id === jobId ? { ...job, status: 'pending' as const } : job)));
  };

  const handleCompleteJob = (jobId: string) => {
    setJobs((prev) =>
      prev.map((job) => (job.id === jobId ? { ...job, status: 'completed' as const, progress: 100 } : job)),
    );
  };

  const handleDeleteJob = (jobId: string) => {
    setJobs((prev) => prev.filter((job) => job.id !== jobId));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-4 text-blue-500" />
          <p className="text-muted-foreground">Loading your job queue...</p>
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

      {/* Header and Stats Section */}
      <div className="mb-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Job Queue</h1>
            <p className="text-muted-foreground mt-1">Manage your personal assistant's tasks and schedule</p>
          </div>
          <Button onClick={() => setShowCreateModal(true)} className="w-full lg:w-auto">
            <Plus className="h-4 w-4 mr-2" />
            Add New Job
          </Button>
        </div>

        {/* Stats Overview */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4 mb-4">
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Target className="h-4 w-4 text-blue-600" />
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
                <Play className="h-4 w-4 text-blue-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Running</p>
                <p className="text-2xl font-bold text-blue-600">{stats.running}</p>
              </div>
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-yellow-100 rounded-lg">
                <Clock className="h-4 w-4 text-yellow-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Pending</p>
                <p className="text-2xl font-bold text-yellow-600">{stats.pending}</p>
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
          <Card className="p-4 col-span-2 md:col-span-1">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Calendar className="h-4 w-4 text-purple-600" />
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Scheduled</p>
                <p className="text-2xl font-bold text-purple-600">{stats.scheduled}</p>
              </div>
            </div>
          </Card>
        </div>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">Sort by:</span>
              <Select
                value={sortBy}
                onValueChange={(value: 'priority' | 'time' | 'category') => setSortBy(value)}
              >
                <Select.Trigger className="w-[140px]">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="priority">Priority</Select.Item>
                  <Select.Item value="time">Time</Select.Item>
                  <Select.Item value="category">Category</Select.Item>
                </Select.Content>
              </Select>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <Tabs.List className="grid w-full grid-cols-5 mb-4">
            <Tabs.Trigger value="all" className="text-xs sm:text-sm">
              All ({stats.total})
            </Tabs.Trigger>
            <Tabs.Trigger value="running" className="text-xs sm:text-sm">
              Running ({stats.running})
            </Tabs.Trigger>
            <Tabs.Trigger value="pending" className="text-xs sm:text-sm">
              Pending ({stats.pending})
            </Tabs.Trigger>
            <Tabs.Trigger value="scheduled" className="text-xs sm:text-sm">
              Scheduled ({stats.scheduled})
            </Tabs.Trigger>
            <Tabs.Trigger value="completed" className="text-xs sm:text-sm">
              Completed ({stats.completed})
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value={activeTab} className="mt-0">
            {sortedJobs.length === 0 ? (
              <div className="text-center py-12">
                <div className="space-y-4">
                  <Zap className="h-12 w-12 mx-auto text-muted-foreground" />
                  <h3 className="text-lg font-semibold">No jobs found</h3>
                  <p className="text-muted-foreground max-w-sm mx-auto">
                    {activeTab === 'all'
                      ? "You're all caught up! Add a new job to get started."
                      : `No ${activeTab} jobs found. Try changing the tab or add a new job.`}
                  </p>
                  <Button onClick={() => setShowCreateModal(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Add New Job
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {sortedJobs.map((job) => (
                  <Card
                    key={job.id}
                    className="relative overflow-hidden hover:shadow-md transition-all duration-200 border-l-4"
                    style={{ borderLeftColor: getStatusColor(job.status).replace('bg-', '') }}
                  >
                    <Card.Header className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start space-x-3 flex-1 min-w-0">
                          <div className={`p-2 rounded-lg ${job.color} bg-opacity-10 flex-shrink-0`}>
                            <job.icon className={`h-5 w-5 ${job.color.replace('bg-', 'text-')}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <Card.Title className="text-base font-semibold truncate">{job.title}</Card.Title>
                            <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                              {job.description}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center space-x-2 flex-shrink-0">
                          <Badge
                            variant="secondary"
                            className={`${getPriorityColor(job.priority)} text-white text-xs`}
                          >
                            {getPriorityText(job.priority)}
                          </Badge>
                        </div>
                      </div>
                    </Card.Header>

                    <Card.Content className="space-y-4">
                      {/* Progress bar for running jobs */}
                      {job.status === 'running' && job.progress !== undefined && (
                        <div className="space-y-2">
                          <div className="flex justify-between text-sm">
                            <span className="text-muted-foreground">Progress</span>
                            <span className="font-medium">{job.progress}%</span>
                          </div>
                          <Progress value={job.progress} className="h-2" />
                        </div>
                      )}

                      {/* Time and category info */}
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center space-x-1">
                          <Timer className="h-4 w-4 text-muted-foreground" />
                          <span className="text-muted-foreground">{job.estimatedDuration} min</span>
                        </div>
                        {job.scheduledFor && (
                          <div className="flex items-center space-x-1">
                            <CalendarDays className="h-4 w-4 text-muted-foreground" />
                            <span className="text-muted-foreground">{formatTime(job.scheduledFor)}</span>
                          </div>
                        )}
                      </div>

                      {/* Tags */}
                      {job.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {job.tags.slice(0, 2).map((tag, index) => (
                            <Badge key={index} variant="outline" className="text-xs">
                              {tag}
                            </Badge>
                          ))}
                          {job.tags.length > 2 && (
                            <Badge variant="outline" className="text-xs">
                              +{job.tags.length - 2}
                            </Badge>
                          )}
                        </div>
                      )}

                      {/* Action buttons */}
                      <div className="flex items-center justify-between pt-2">
                        <div className="flex items-center space-x-2">
                          {job.status === 'pending' && (
                            <Button
                              size="sm"
                              onClick={() => handleStartJob(job.id)}
                              className="bg-green-600 hover:bg-green-700"
                            >
                              <Play className="h-4 w-4 mr-1" />
                              Start
                            </Button>
                          )}
                          {job.status === 'running' && (
                            <>
                              <Button size="sm" variant="outline" onClick={() => handlePauseJob(job.id)}>
                                <Pause className="h-4 w-4 mr-1" />
                                Pause
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => handleCompleteJob(job.id)}
                                className="bg-blue-600 hover:bg-blue-700"
                              >
                                <CheckCircle className="h-4 w-4 mr-1" />
                                Complete
                              </Button>
                            </>
                          )}
                          {job.status === 'failed' && (
                            <Button
                              size="sm"
                              onClick={() => handleStartJob(job.id)}
                              className="bg-orange-600 hover:bg-orange-700"
                            >
                              <RefreshCw className="h-4 w-4 mr-1" />
                              Retry
                            </Button>
                          )}
                        </div>
                        <div className="flex items-center space-x-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setSelectedJob(job);
                              setShowEditModal(true);
                            }}
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleDeleteJob(job.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </Card.Content>
                  </Card>
                ))}
              </div>
            )}
          </Tabs.Content>
        </Tabs>
      </div>

      {/* Create Job Modal */}
      <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
        <Dialog.Content className="sm:max-w-[500px]">
          <Dialog.Header>
            <Dialog.Title>Add New Job</Dialog.Title>
            <Dialog.Description>Create a new task for your personal assistant to handle.</Dialog.Description>
          </Dialog.Header>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="title">Job Title</Label>
              <Input id="title" placeholder="e.g., Morning Workout" />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="description">Description</Label>
              <Input id="description" placeholder="Brief description of the task" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="priority">Priority</Label>
                <Select>
                  <Select.Trigger>
                    <Select.Value placeholder="Select priority" />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="low">Low</Select.Item>
                    <Select.Item value="medium">Medium</Select.Item>
                    <Select.Item value="high">High</Select.Item>
                    <Select.Item value="urgent">Urgent</Select.Item>
                  </Select.Content>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="category">Category</Label>
                <Select>
                  <Select.Trigger>
                    <Select.Value placeholder="Select category" />
                  </Select.Trigger>
                  <Select.Content>
                    <Select.Item value="personal">Personal</Select.Item>
                    <Select.Item value="work">Work</Select.Item>
                    <Select.Item value="health">Health</Select.Item>
                    <Select.Item value="learning">Learning</Select.Item>
                    <Select.Item value="entertainment">Entertainment</Select.Item>
                    <Select.Item value="travel">Travel</Select.Item>
                    <Select.Item value="shopping">Shopping</Select.Item>
                  </Select.Content>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="duration">Duration (minutes)</Label>
                <Input id="duration" type="number" placeholder="30" />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="schedule">Schedule</Label>
                <Input id="schedule" type="datetime-local" />
              </div>
            </div>
          </div>

          <Dialog.Footer>
            <Button variant="outline" onClick={() => setShowCreateModal(false)}>
              Cancel
            </Button>
            <Button onClick={() => setShowCreateModal(false)}>Create Job</Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      {/* Edit Job Modal */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <Dialog.Content className="sm:max-w-[500px]">
          <Dialog.Header>
            <Dialog.Title>Edit Job</Dialog.Title>
            <Dialog.Description>Update the details of this job.</Dialog.Description>
          </Dialog.Header>

          {selectedJob && (
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="edit-title">Job Title</Label>
                <Input id="edit-title" defaultValue={selectedJob.title} />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="edit-description">Description</Label>
                <Input id="edit-description" defaultValue={selectedJob.description} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="edit-priority">Priority</Label>
                  <Select defaultValue={selectedJob.priority}>
                    <Select.Trigger>
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="low">Low</Select.Item>
                      <Select.Item value="medium">Medium</Select.Item>
                      <Select.Item value="high">High</Select.Item>
                      <Select.Item value="urgent">Urgent</Select.Item>
                    </Select.Content>
                  </Select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="edit-category">Category</Label>
                  <Select defaultValue={selectedJob.category}>
                    <Select.Trigger>
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="personal">Personal</Select.Item>
                      <Select.Item value="work">Work</Select.Item>
                      <Select.Item value="health">Health</Select.Item>
                      <Select.Item value="learning">Learning</Select.Item>
                      <Select.Item value="entertainment">Entertainment</Select.Item>
                      <Select.Item value="travel">Travel</Select.Item>
                      <Select.Item value="shopping">Shopping</Select.Item>
                    </Select.Content>
                  </Select>
                </div>
              </div>
            </div>
          )}

          <Dialog.Footer>
            <Button variant="outline" onClick={() => setShowEditModal(false)}>
              Cancel
            </Button>
            <Button onClick={() => setShowEditModal(false)}>Save Changes</Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
