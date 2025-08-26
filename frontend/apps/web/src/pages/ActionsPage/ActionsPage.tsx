import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Card, Switch } from '@ci/shadcn';
import { Bot, Clapperboard, Play, Utensils } from '@ci/shadcn/icons';

import { PageContent } from '@/components/layout';

import { useToolPreferences } from './useToolPreferences';

interface ToolCard {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: React.ReactNode;
  capabilities: string[];
  canToggle: boolean;
  systemStatus: 'active' | 'disabled'; // Backend/system status
}

const AVAILABLE_TOOLS: ToolCard[] = [
  {
    id: 'food-preferences',
    name: 'Food Preferences',
    description:
      'Get user food preferences, dietary restrictions, allergies, and eating habits for meal planning and cooking recommendations.',
    category: 'Lifestyle',
    icon: <Utensils className="h-6 w-6" />,
    capabilities: [
      'Dietary restrictions and allergies',
      'Food preferences and dislikes',
      'Cooking habits and skills',
      'Meal planning assistance',
    ],
    canToggle: true,
    systemStatus: 'active',
  },
  {
    id: 'entertainment-preferences',
    name: 'Entertainment Preferences',
    description:
      'Access movie genres, TV show types, streaming preferences, and viewing habits for personalized entertainment recommendations.',
    category: 'Entertainment',
    icon: <Clapperboard className="h-6 w-6" />,
    capabilities: [
      'Movie and TV genre preferences',
      'Streaming service preferences',
      'Viewing habits and schedules',
      'Content recommendation support',
    ],
    canToggle: true,
    systemStatus: 'active',
  },
  {
    id: 'streaming-availability',
    name: 'Streaming Availability',
    description:
      'Check what movies and TV shows are currently available across different streaming platforms.',
    category: 'Entertainment',
    icon: <Play className="h-6 w-6" />,
    capabilities: [
      'Multi-platform availability check',
      'Real-time streaming data',
      'Content discovery assistance',
      'Platform comparison',
    ],
    canToggle: true,
    systemStatus: 'active',
  },
  {
    id: 'family-members',
    name: 'Family Members',
    description:
      'Access information about family members and relationships for personalized interactions and planning.',
    category: 'Personal',
    icon: <Bot className="h-6 w-6" />,
    capabilities: [
      'Family member profiles',
      'Relationship context',
      'Personal interaction history',
      'Family-based recommendations',
    ],
    canToggle: false, // Cannot toggle system-disabled tools
    systemStatus: 'disabled',
  },
];

const ToolCard = ({
  tool,
  isEnabled,
  onToggle,
}: {
  tool: ToolCard;
  isEnabled: boolean;
  onToggle: (toolId: string) => void;
}) => {
  const isEffectivelyEnabled = tool.systemStatus === 'active' && isEnabled;
  const canInteract = tool.canToggle && tool.systemStatus === 'active';

  return (
    <Card
      className={`h-full transition-all duration-200 ${
        isEffectivelyEnabled ? 'hover:shadow-md hover:border-primary/20' : 'opacity-60 border-dashed'
      }`}
    >
      <Card.Header className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`p-2 rounded-lg ${
                isEffectivelyEnabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
              }`}
            >
              {tool.icon}
            </div>
            <div>
              <Card.Title className="text-lg">{tool.name}</Card.Title>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs px-2 py-1 rounded-full bg-muted text-muted-foreground">
                  {tool.category}
                </span>
                <span
                  className={`text-xs px-2 py-1 rounded-full ${
                    isEffectivelyEnabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                  }`}
                >
                  {isEffectivelyEnabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            </div>
          </div>

          {/* Toggle Switch */}
          <div className="flex flex-col items-end gap-1">
            <Switch
              checked={isEnabled}
              onCheckedChange={() => canInteract && onToggle(tool.id)}
              disabled={!canInteract}
              aria-label={`Toggle ${tool.name}`}
              className="data-[state=unchecked]:opacity-50"
            />
            {!tool.canToggle && <span className="text-xs text-muted-foreground">System</span>}
          </div>
        </div>
      </Card.Header>

      <Card.Content className="space-y-4">
        <p className="text-sm text-muted-foreground leading-relaxed">{tool.description}</p>

        <div>
          <h4 className="text-sm font-medium mb-2">Capabilities:</h4>
          <ul className="space-y-1">
            {tool.capabilities.map((capability, index) => (
              <li key={index} className="text-xs text-muted-foreground flex items-start gap-2">
                <span className="text-primary mt-1">•</span>
                <span>{capability}</span>
              </li>
            ))}
          </ul>
        </div>

        {tool.systemStatus === 'disabled' && (
          <div className="text-xs text-orange-600 bg-orange-50 p-2 rounded-md">
            This tool is currently disabled at the system level for demo purposes.
          </div>
        )}
      </Card.Content>
    </Card>
  );
};

export function ActionsPage() {
  usePageTitle('Actions - Companion Intelligence');

  const { isToolEnabled, toggleTool, getEnabledToolsCount, getDisabledToolsCount, isLoading } =
    useToolPreferences();

  if (isLoading) {
    return (
      <div className="flex flex-col w-full space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">Available Actions</h1>
          <p className="text-muted-foreground">Loading tool preferences...</p>
        </div>
      </div>
    );
  }

  const enabledCount = getEnabledToolsCount();
  const disabledCount = getDisabledToolsCount();

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
              <Breadcrumb.Page>Actions</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        {/* Header Section */}
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">Available Actions</h1>
          <p className="text-muted-foreground">
            AI-powered tools that enhance your conversations with personalized data and capabilities. Toggle
            tools on or off to customize your experience.
          </p>
        </div>

        {/* Stats Section */}
        <div className="flex gap-4 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-green-500 rounded-full"></div>
            <span>{enabledCount} Enabled Tools</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 bg-gray-400 rounded-full"></div>
            <span>{disabledCount} Disabled Tools</span>
          </div>
        </div>

        {/* All Tools Grid */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">AI Tools</h2>
            <p className="text-sm text-muted-foreground">
              Use the toggles to enable or disable tools for your conversations
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {AVAILABLE_TOOLS.map((tool) => (
              <ToolCard key={tool.id} tool={tool} isEnabled={isToolEnabled(tool.id)} onToggle={toggleTool} />
            ))}
          </div>
        </div>

        {/* Help Text */}
        <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
          <h3 className="text-sm font-medium text-blue-900 mb-2">How Tool Toggles Work</h3>
          <ul className="text-sm text-blue-800 space-y-1">
            <li>
              • <strong>Enabled tools</strong> are available for AI conversations and will provide
              personalized responses
            </li>
            <li>
              • <strong>Disabled tools</strong> won't be used by the AI, giving you control over data access
            </li>
            <li>
              • <strong>System tools</strong> are controlled by administrators and cannot be toggled by users
            </li>
            <li>• Your preferences are saved locally and will persist between sessions</li>
          </ul>
        </div>
      </PageContent>
    </>
  );
}
