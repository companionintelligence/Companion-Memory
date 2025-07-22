import { Suspense } from 'react';

import { LoadingPage, Portal } from '@ci/common';
import { Separator, Sidebar, Toaster, useSidebar } from '@ci/shadcn';
import {
  BookA,
  BookImage,
  Bot,
  Brain,
  Camera,
  ChartPie,
  Lightbulb,
  ListTodo,
  MessageCircleQuestion,
  Search,
  Settings2,
} from '@ci/shadcn/icons';
import { Outlet } from 'react-router-dom';

import logo from '../../assets/logo.png';

import { NavSection } from './NavSection';
import { NavUser } from './NavUser';

const INTELLIGENCE = [
  {
    name: 'Search',
    url: '/search',
    icon: Search,
  },
  {
    name: 'Questions',
    url: '/questions',
    icon: MessageCircleQuestion,
  },
  {
    name: 'Answers',
    url: '/answers',
    icon: BookA,
  },
  {
    name: 'Insights',
    url: '/insights',
    icon: Lightbulb,
  },
  {
    name: 'Chat',
    url: '/chat',
    icon: Bot,
  },
  {
    name: 'Connections',
    url: '/connections',
    icon: Bot,
  },
];

const MEMORY = [
  {
    name: 'Memory',
    url: '/memory',
    icon: Brain,
  },
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
    name: 'Dashboard',
    url: '/dashboard',
    icon: ChartPie,
  },
  {
    name: 'Jobs',
    url: '/jobs',
    icon: ListTodo,
  },
  {
    name: 'Settings',
    url: '/settings',
    icon: Settings2,
  },
];

function SecondaryNavigation() {
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
          <NavSection title="Memory" items={MEMORY} />
          <NavSection title="System" items={SYSTEM} />
        </Sidebar.Content>
        <Sidebar.Footer>
          <NavUser />
        </Sidebar.Footer>
      </Sidebar>
    </>
  );
}

export function Main() {
  return (
    <>
      <Sidebar.Provider>
        <SecondaryNavigation />

        <Sidebar.Inset>
          <Suspense fallback={<LoadingPage />}>
            <Toaster />

            <div className="min-h-screen flex flex-col">
              <header className="flex flex-row items-center justify-between pl-2 pr-4 py-2 border-b">
                <section className="flex flex-row items-center">
                  <Sidebar.Trigger />
                  <Separator orientation="vertical" className="ml-2 mr-3 data-[orientation=vertical]:h-5" />
                  <Portal id="breadcrumbs" />
                </section>

                <aside>
                  <Portal id="actions" />
                </aside>
              </header>

              <div className="flex flex-row grow">
                <main className="flex grow p-4">
                  <Outlet />
                </main>
                <aside className="flex flex-col">
                  <Portal id="tertiary-navigation" className="flex flex-col grow" />
                </aside>
              </div>
            </div>
          </Suspense>
        </Sidebar.Inset>
      </Sidebar.Provider>
    </>
  );
}
