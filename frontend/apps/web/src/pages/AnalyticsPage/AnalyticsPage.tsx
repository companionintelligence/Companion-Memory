import { useEffect } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Card } from '@ci/shadcn';

import { ChartAreaInteractive } from '@/components/chart-area-interactive';
import { PageContent } from '@/components/layout';
import { useAuth } from '@/hooks';

interface StatCard {
  title: string;
  value: string | number;
  description?: string;
  icon: React.ReactNode;
  trend?: {
    value: number;
    isPositive: boolean;
  };
}

const StatCard = ({ title, value, description, icon, trend }: StatCard) => (
  <Card>
    <Card.Header className="flex flex-row items-center justify-between space-y-0 pb-2">
      <Card.Title className="text-sm font-medium">{title}</Card.Title>
      <div className="text-muted-foreground">{icon}</div>
    </Card.Header>
    <Card.Content>
      <div className="text-2xl font-bold">{value}</div>
      {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      {trend && (
        <div
          className={`flex items-center text-xs mt-2 ${trend.isPositive ? 'text-green-600' : 'text-red-600'}`}
        >
          📈 {trend.value}% from last week
        </div>
      )}
    </Card.Content>
  </Card>
);

const ActivityItem = ({
  time,
  activity,
  icon,
}: {
  time: string;
  activity: string;
  icon: React.ReactNode;
}) => (
  <div className="flex items-start space-x-3 py-3 border-b last:border-0">
    <div className="text-muted-foreground mt-0.5">{icon}</div>
    <div className="flex-1">
      <p className="text-sm">{activity}</p>
      <p className="text-xs text-muted-foreground">{time}</p>
    </div>
  </div>
);

const RecommendationItem = ({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
}) => (
  <div className="flex items-start space-x-3 p-3 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer">
    <div className="text-primary mt-0.5">{icon}</div>
    <div className="flex-1">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  </div>
);

export function AnalyticsPage() {
  usePageTitle('Dashboard - Companion Intelligence');

  const [{ user, loading, error }] = useAuth();

  const fetchMetrics = async () => {
    // Mock function for now
    console.log('Fetching metrics...');
  };

  // Mock data for statistics
  const stats = [
    {
      title: 'Total Activities',
      value: '2,847',
      description: 'Tracked this month',
      icon: '📊',
      trend: { value: 12, isPositive: true },
    },
    {
      title: 'Active Conversations',
      value: '23',
      description: 'Across 5 AI coaches',
      icon: '💬',
      trend: { value: 8, isPositive: true },
    },
    {
      title: 'Tasks Completed',
      value: '156',
      description: 'This week',
      icon: '✅',
      trend: { value: 23, isPositive: true },
    },
    {
      title: 'Insights Generated',
      value: '89',
      description: 'Personal insights',
      icon: '🧠',
      trend: { value: 5, isPositive: false },
    },
  ];

  const recentActivities = [
    { time: '2 minutes ago', activity: 'Completed morning meditation session', icon: '🧠' },
    { time: '1 hour ago', activity: 'AI Coach suggested new productivity workflow', icon: '✨' },
    { time: '3 hours ago', activity: 'Logged workout: 45 min cardio session', icon: '💪' },
    { time: '5 hours ago', activity: 'Answered 3 personal development questions', icon: '💬' },
    { time: 'Yesterday', activity: 'Weekly goal review completed', icon: '🎯' },
  ];

  const recommendations = [
    {
      title: 'Schedule Deep Work Time',
      description: 'Your productivity peaks at 10 AM. Block 2 hours tomorrow.',
      icon: '⏰',
    },
    {
      title: 'Connect with Sarah',
      description: "It's been 2 weeks since your last conversation.",
      icon: '👥',
    },
    {
      title: 'Review Weekly Goals',
      description: '3 goals need attention before Friday.',
      icon: '🎯',
    },
    {
      title: 'Mindfulness Break',
      description: "You've been active for 3 hours. Time for a 5-min break.",
      icon: '🧠',
    },
  ];

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 30000);

    return () => clearInterval(interval);
  }, []);

  if (!user) {
    return <div>Please log in to view the dashboard.</div>;
  }

  if (loading) {
    return <div className="p-6">Loading dashboard...</div>;
  }

  if (error) {
    return <div className="p-6 text-red-600">Error: {error + ''}</div>;
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
              <Breadcrumb.Page>Dashboard</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        <div className="flex-1 space-y-4">
          {/* Stats Grid */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {stats.map((stat, index) => (
              <StatCard key={index} {...stat} />
            ))}
          </div>

          {/* Main Content Grid */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
            {/* Activity Chart */}
            <div className="col-span-full lg:col-span-4">
              <ChartAreaInteractive />
            </div>

            {/* Recommendations */}
            <Card className="col-span-full md:col-span-1 lg:col-span-3">
              <Card.Header>
                <Card.Title className="flex items-center gap-2">✨ AI Recommendations</Card.Title>
                <Card.Description>Personalized suggestions based on your patterns</Card.Description>
              </Card.Header>
              <Card.Content className="space-y-1">
                {recommendations.map((rec, index) => (
                  <RecommendationItem key={index} {...rec} />
                ))}
              </Card.Content>
            </Card>
          </div>

          {/* Bottom Section */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
            {/* Recent Activities */}
            <Card className="col-span-full md:col-span-1 lg:col-span-4">
              <Card.Header>
                <Card.Title>Recent Activities</Card.Title>
                <Card.Description>Your latest tracked activities and interactions</Card.Description>
              </Card.Header>
              <Card.Content>
                {recentActivities.map((activity, index) => (
                  <ActivityItem key={index} {...activity} />
                ))}
              </Card.Content>
            </Card>

            {/* Quick Stats */}
            <Card className="col-span-full md:col-span-1 lg:col-span-3">
              <Card.Header>
                <Card.Title>Activity Insights</Card.Title>
                <Card.Description>Your personal patterns and habits</Card.Description>
              </Card.Header>
              <Card.Content className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Most Active Day</span>
                    <span className="text-sm text-muted-foreground">Wednesday</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Peak Productivity</span>
                    <span className="text-sm text-muted-foreground">10 AM - 12 PM</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Avg. Daily Activities</span>
                    <span className="text-sm text-muted-foreground">94</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Streak</span>
                    <span className="text-sm text-muted-foreground">12 days 🔥</span>
                  </div>
                </div>

                <div className="pt-4 border-t">
                  <h4 className="text-sm font-medium mb-3">Top Categories</h4>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-blue-500 rounded-full" />
                        <span className="text-sm">Work & Productivity</span>
                      </div>
                      <span className="text-sm text-muted-foreground">42%</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-green-500 rounded-full" />
                        <span className="text-sm">Health & Fitness</span>
                      </div>
                      <span className="text-sm text-muted-foreground">28%</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-purple-500 rounded-full" />
                        <span className="text-sm">Learning & Growth</span>
                      </div>
                      <span className="text-sm text-muted-foreground">18%</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-orange-500 rounded-full" />
                        <span className="text-sm">Social & Relationships</span>
                      </div>
                      <span className="text-sm text-muted-foreground">12%</span>
                    </div>
                  </div>
                </div>
              </Card.Content>
            </Card>
          </div>
        </div>
      </PageContent>
    </>
  );
}
