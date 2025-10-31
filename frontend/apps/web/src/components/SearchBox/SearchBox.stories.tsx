import type { ComponentProps } from 'react';

import { Input } from '@ci/shadcn';
import { User, FileText, MapPin, Calendar } from '@ci/shadcn/icons';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';

import { SearchBox } from './SearchBox';

type Props = ComponentProps<typeof SearchBox>;

const sampleResults = [
  {
    id: '1',
    content: (
      <div className="flex items-center gap-2 text-sm">
        <User className="h-4 w-4 text-blue-500" />
        <span className="font-medium">John Smith</span>
        <span className="text-muted-foreground">Contact</span>
      </div>
    ),
    preview: (
      <div className="space-y-2">
        <div className="font-medium">John Smith</div>
        <div className="text-muted-foreground">Software Engineer</div>
        <div className="text-xs">
          <div>📧 john.smith@example.com</div>
          <div>📱 +1 (555) 123-4567</div>
          <div>🏢 Tech Corp Inc.</div>
        </div>
      </div>
    ),
  },
  {
    id: '2',
    content: (
      <div className="flex items-center gap-2 text-sm">
        <FileText className="h-4 w-4 text-green-500" />
        <span className="font-medium">Meeting Notes.pdf</span>
        <span className="text-muted-foreground">Document</span>
      </div>
    ),
    preview: (
      <div className="space-y-2">
        <div className="font-medium">Meeting Notes.pdf</div>
        <div className="text-muted-foreground">Team Standup - January 15, 2025</div>
        <div className="text-xs">
          <div>📄 2.3 MB • Modified 2 hours ago</div>
          <div className="mt-2 p-2 bg-muted/50 rounded text-xs">
            "Discussed project timeline, identified blockers in authentication system..."
          </div>
        </div>
      </div>
    ),
  },
  {
    id: '3',
    content: (
      <div className="flex items-center gap-2 text-sm">
        <MapPin className="h-4 w-4 text-red-500" />
        <span className="font-medium">Coffee Shop on Main St</span>
        <span className="text-muted-foreground">Place</span>
      </div>
    ),
    preview: (
      <div className="space-y-2">
        <div className="font-medium">The Daily Grind</div>
        <div className="text-muted-foreground">📍 123 Main Street, Downtown</div>
        <div className="text-xs">
          <div>⭐ 4.5/5 • Coffee Shop</div>
          <div>🕐 Open 6:00 AM - 8:00 PM</div>
          <div className="mt-2 text-muted-foreground">Last visited: Yesterday at 9:15 AM</div>
        </div>
      </div>
    ),
  },
  {
    id: '4',
    content: (
      <div className="flex items-center gap-2 text-sm">
        <Calendar className="h-4 w-4 text-purple-500" />
        <span className="font-medium">Team Meeting</span>
        <span className="text-muted-foreground">Event</span>
        <span className="text-muted-foreground">(Tomorrow 2:00 PM)</span>
      </div>
    ),
    preview: (
      <div className="space-y-2">
        <div className="font-medium">Weekly Team Standup</div>
        <div className="text-muted-foreground">📅 Tomorrow at 2:00 PM</div>
        <div className="text-xs">
          <div>⏰ 30 minutes • Conference Room A</div>
          <div>👥 8 attendees</div>
          <div className="mt-2 p-2 bg-muted/50 rounded text-xs">
            Agenda: Sprint review, blockers discussion, next week planning
          </div>
        </div>
      </div>
    ),
  },
  {
    id: '5',
    content: (
      <div className="flex items-center gap-2 text-sm">
        <FileText className="h-4 w-4 text-orange-500" />
        <span className="font-medium">Project Proposal.docx</span>
        <span className="text-muted-foreground">Document</span>
      </div>
    ),
    preview: (
      <div className="space-y-2">
        <div className="font-medium">AI Integration Proposal</div>
        <div className="text-muted-foreground">Draft document</div>
        <div className="text-xs">
          <div>📄 1.8 MB • Last edited 5 minutes ago</div>
          <div className="mt-2 p-2 bg-muted/50 rounded text-xs">
            "Executive summary of proposed AI features for Q2 roadmap including LLM integration..."
          </div>
        </div>
      </div>
    ),
  },
  {
    id: '6',
    content: (
      <div className="flex items-center gap-2 text-sm">
        <User className="h-4 w-4 text-blue-500" />
        <span className="font-medium">Sarah Johnson</span>
        <span className="text-muted-foreground">Contact</span>
      </div>
    ),
    preview: (
      <div className="space-y-2">
        <div className="font-medium">Sarah Johnson</div>
        <div className="text-muted-foreground">Product Manager</div>
        <div className="text-xs">
          <div>📧 sarah.j@company.com</div>
          <div>📱 +1 (555) 987-6543</div>
          <div>🏢 Design Systems Team</div>
        </div>
      </div>
    ),
  },
];

const meta: Meta<Props> = {
  component: SearchBox,
  parameters: {
    layout: 'padded',
  },
  args: {
    onSearch: fn(),
    onResultSelect: fn(),
  },
  decorators: [(Story) => <Story />],
};

export default meta;

type Story = StoryObj<Props>;

export const Default: Story = {};

export const Compact: Story = {
  args: {
    variant: 'compact',
  },
};

export const Loading: Story = {
  args: {
    loading: true,
  },
  decorators: [
    (Story) => (
      <div className="w-180">
        <Story />
        <p className="text-xs text-muted-foreground mt-4">Type in search box to see the loading state</p>
      </div>
    ),
  ],
};

export const Error: Story = {
  args: {
    error: 'Network error occurred',
  },
  decorators: [
    (Story) => (
      <div className="w-180">
        <Story />
        <p className="text-xs text-muted-foreground mt-4">Type in search box to see the error state</p>
      </div>
    ),
  ],
};

export const Disabled: Story = {
  args: {
    disabled: true,
    variant: 'compact',
  },
  decorators: [
    (Story) => (
      <div className="flex gap-4">
        <div className="flex-1">
          <Input placeholder="Enter text here..." disabled />
        </div>
        <div className="flex-1">
          <Story />
        </div>
      </div>
    ),
  ],
};

export const NextToShadCNInput: Story = {
  args: {
    variant: 'compact',
  },
  decorators: [
    (Story) => (
      <div className="flex gap-4">
        <div className="flex-1">
          <Input placeholder="Enter text here..." />
        </div>
        <div className="flex-1">
          <Story />
        </div>
      </div>
    ),
  ],
};

export const NoResults: Story = {
  args: {
    results: [],
    autoSubmit: true,
  },
  decorators: [
    (Story) => (
      <div className="w-180">
        <Story />
        <p className="text-xs text-muted-foreground mt-4">Type in search box to see results appear</p>
      </div>
    ),
  ],
};

export const SingleResult: Story = {
  args: {
    results: [sampleResults[0]],
    autoSubmit: true,
  },
  decorators: [
    (Story) => (
      <div className="w-180">
        <Story />
        <p className="text-xs text-muted-foreground mt-4">Type in search box to see results appear</p>
      </div>
    ),
  ],
};

export const ManyResults: Story = {
  args: {
    results: sampleResults,
    autoSubmit: true,
  },
  decorators: [
    (Story) => (
      <div className="w-180">
        <Story />
        <p className="text-xs text-muted-foreground mt-4">Type in search box to see results appear</p>
      </div>
    ),
  ],
};
