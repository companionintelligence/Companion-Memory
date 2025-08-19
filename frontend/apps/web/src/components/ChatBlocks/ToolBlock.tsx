import React from 'react';

import { Wrench } from '@ci/shadcn/icons';

interface ToolBlockProps {
  toolName: string;
}

export const ToolBlock: React.FC<ToolBlockProps> = ({ toolName }) => {
  return (
    <div className="flex items-center gap-2 py-2 px-3 bg-blue-50 dark:bg-blue-950/30 rounded-lg border border-blue-200 dark:border-blue-800/50 text-sm">
      <Wrench className="h-4 w-4 text-blue-600 dark:text-blue-400 animate-pulse" />
      <span className="text-blue-700 dark:text-blue-300 font-medium">Calling {toolName}...</span>
    </div>
  );
};
