import { Sidebar, useSidebar } from '@ci/shadcn';
import {
  BookImage,
  Brain,
  Cable,
  Camera,
  ChartPie,
  Inbox,
  Lightbulb,
  ListTodo,
  MessagesSquare,
  Search,
  Settings2,
  Zap,
} from '@ci/shadcn/icons';

import logo from '../../../assets/logo.png';

import { NavSection } from './NavSection';
import { NavUser } from './NavUser';

const INTELLIGENCE = [
  {
    name: 'Feed',
    url: '/feed',
    icon: Inbox,
  },
  {
    name: 'Search',
    url: '/search',
    icon: Search,
  },
  {
    name: 'Memory',
    url: '/memory',
    icon: Brain,
  },
  {
    name: 'Insights',
    url: '/insights',
    icon: Lightbulb,
  },
  {
    name: 'Actions',
    url: '/actions',
    icon: Zap,
  },
  {
    name: 'Chat',
    url: '/chat',
    icon: MessagesSquare,
  },
];

const CONTENT = [
  {
    name: 'Content',
    url: '/files',
    icon: BookImage,
  },
  {
    name: 'Capture',
    url: '/capture',
    icon: Camera,
  },
];

const SYSTEM = [
  {
    name: 'Analytics',
    url: '/analytics',
    icon: ChartPie,
  },
  {
    name: 'Jobs',
    url: '/jobs',
    icon: ListTodo,
  },
  {
    name: 'Connections',
    url: '/connections',
    icon: Cable,
  },
  {
    name: 'Settings',
    url: '/settings',
    icon: Settings2,
  },
];

export function SecondaryNavigation() {
  const { open } = useSidebar();

  return (
    <>
      <Sidebar collapsible="icon">
        <Sidebar.Header>
          <div className="flex flex-row items-center gap-2">
            <img src={logo} alt="Logo" className="w-8 h-auto" />
            {open && <div>Companion Intelligence</div>}
          </div>
        </Sidebar.Header>
        <Sidebar.Content className="gap-0">
          <NavSection title="Intelligence" items={INTELLIGENCE} />
          <NavSection title="Content" items={CONTENT} />
        </Sidebar.Content>
        <Sidebar.Footer>
          <NavSection items={SYSTEM} />
          <NavUser />
        </Sidebar.Footer>
      </Sidebar>
    </>
  );
}
