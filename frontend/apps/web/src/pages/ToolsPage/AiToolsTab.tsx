import { Card, Switch } from '@ci/shadcn';
import {
  Bot,
  BookOpen,
  Clapperboard,
  Music,
  Plane,
  Play,
  ShoppingBag,
  Utensils,
  Search,
  Dumbbell,
} from '@ci/shadcn/icons';

import { useToolPreferences } from './useToolPreferences';

interface ToolCard {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: React.ReactNode;
  capabilities: string[];
  canToggle: boolean;
  systemStatus: 'active' | 'disabled';
  isDemo?: boolean; // Purely aesthetic demo tool that always appears enabled
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
    canToggle: true,
    systemStatus: 'active',
  },
  {
    id: 'shopping-preferences',
    name: 'Shopping Preferences',
    description:
      'Track shopping habits, preferred brands, purchase history, and price tracking for smart shopping recommendations.',
    category: 'Lifestyle',
    icon: <ShoppingBag className="h-6 w-6" />,
    capabilities: [
      'Brand and store preferences',
      'Purchase history tracking',
      'Price alerts and deals',
      'Wishlist management',
    ],
    canToggle: true,
    systemStatus: 'active',
    isDemo: true,
  },
  {
    id: 'travel-assistant',
    name: 'Travel Assistant',
    description:
      'Manage travel preferences, favorite destinations, trip history, and travel-related information for personalized travel planning.',
    category: 'Travel',
    icon: <Plane className="h-6 w-6" />,
    capabilities: [
      'Favorite destinations and places',
      'Travel history and itineraries',
      'Accommodation preferences',
      'Destination recommendations',
    ],
    canToggle: true,
    systemStatus: 'active',
    isDemo: true,
  },
  {
    id: 'reading-habits',
    name: 'Reading Habits',
    description:
      'Track reading preferences, book history, favorite genres, and reading patterns for personalized book recommendations.',
    category: 'Entertainment',
    icon: <BookOpen className="h-6 w-6" />,
    capabilities: [
      'Book genre preferences',
      'Reading history and favorites',
      'Reading pace and habits',
      'Personalized recommendations',
    ],
    canToggle: true,
    systemStatus: 'active',
    isDemo: true,
  },
  {
    id: 'music-preferences',
    name: 'Music Preferences',
    description:
      'Access music taste, favorite artists, genres, listening history, and streaming preferences for music discovery.',
    category: 'Entertainment',
    icon: <Music className="h-6 w-6" />,
    capabilities: [
      'Artist and genre preferences',
      'Listening history and patterns',
      'Streaming service preferences',
      'Playlist and discovery support',
    ],
    canToggle: true,
    systemStatus: 'active',
    isDemo: true,
  },
  {
    id: 'fitness-tracking',
    name: 'Fitness Tracking',
    description:
      'Monitor fitness goals, workout preferences, activity patterns, and health metrics for personalized fitness guidance.',
    category: 'Health',
    icon: <Dumbbell className="h-6 w-6" />,
    capabilities: [
      'Workout preferences and routines',
      'Fitness goals and progress',
      'Activity tracking history',
      'Personalized fitness recommendations',
    ],
    canToggle: true,
    systemStatus: 'active',
    isDemo: true,
  },
  {
    id: 'search-knowledge',
    name: 'Knowledge Search',
    description:
      'Run semantic searches across the personal knowledge graph to find relevant entities, documents, and facts for follow-up actions.',
    category: 'Knowledge',
    icon: <Search className="h-6 w-6" />,
    capabilities: [
      'Semantic graph search',
      'Entity-centric results with IDs',
      'Document and fact discovery',
      'Jump-start follow-up graph traversals',
    ],
    canToggle: true,
    systemStatus: 'active',
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
  // Demo tools always appear enabled for aesthetic purposes
  const isEffectivelyEnabled = tool.isDemo ? true : tool.systemStatus === 'active' && isEnabled;
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

          <div className="flex flex-col items-end gap-1">
            <Switch
              checked={tool.isDemo ? true : isEnabled}
              onCheckedChange={() => {
                if (!tool.isDemo && canInteract) {
                  onToggle(tool.id);
                }
                // Demo tools: toggle does nothing, purely aesthetic
              }}
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

export function AiToolsTab() {
  const { isToolEnabled, toggleTool, getEnabledToolsCount, getDisabledToolsCount, isLoading } =
    useToolPreferences();

  if (isLoading) {
    return (
      <div className="flex flex-col w-full space-y-6">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">AI Tools</h2>
          <p className="text-muted-foreground">Loading tool preferences...</p>
        </div>
      </div>
    );
  }

  // Include demo tools in the enabled count for display purposes
  const demoToolsCount = AVAILABLE_TOOLS.filter((tool) => tool.isDemo).length;
  const enabledCount = getEnabledToolsCount() + demoToolsCount;
  const disabledCount = getDisabledToolsCount();

  return (
    <div className="space-y-6">
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

      {/* Tools Grid */}
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
    </div>
  );
}
