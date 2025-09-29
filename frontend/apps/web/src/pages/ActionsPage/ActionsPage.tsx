import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Tabs } from '@ci/shadcn';
import { Bot, Server } from '@ci/shadcn/icons';

import { PageContent } from '@/components/layout';

import { AiToolsTab } from './AiToolsTab';
import { McpToolsTab } from './McpToolsTab';

export function ActionsPage() {
  usePageTitle('Actions - Companion Intelligence');

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
            Manage AI-powered tools and external capabilities that enhance your conversations with
            personalized data and advanced functionality.
          </p>
        </div>

        {/* Tabs Section */}
        <Tabs defaultValue="ai-tools" className="w-full">
          <Tabs.List className="grid w-full grid-cols-2 max-w-md">
            <Tabs.Trigger value="ai-tools" className="flex items-center gap-2">
              <Bot className="h-4 w-4" />
              AI Tools
            </Tabs.Trigger>
            <Tabs.Trigger value="mcp-tools" className="flex items-center gap-2">
              <Server className="h-4 w-4" />
              MCP Servers
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="ai-tools" className="mt-6">
            <AiToolsTab />
          </Tabs.Content>

          <Tabs.Content value="mcp-tools" className="mt-6">
            <McpToolsTab />
          </Tabs.Content>
        </Tabs>
      </PageContent>
    </>
  );
}
