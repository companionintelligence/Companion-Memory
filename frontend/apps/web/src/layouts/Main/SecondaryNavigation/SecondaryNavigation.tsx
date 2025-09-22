import { Sidebar, useSidebar } from '@ci/shadcn';
import {
  Brain,
  Cable,
  ChartPie,
  Inbox,
  Lightbulb,
  ListTodo,
  MessagesSquare,
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
        </Sidebar.Content>
        <Sidebar.Footer>
          <NavSection items={SYSTEM} centerIconsWhenCollapsed={true} />
          <NavUser />
        </Sidebar.Footer>
      </Sidebar>
    </>
  );
}
