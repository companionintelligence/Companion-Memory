import { usePageTitle } from '@ci/common';
import { Button } from '@ci/shadcn';
import { BookImage, Brain, Lightbulb, MessagesSquare } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { PageContent } from '@/components/layout';
import { SearchInput } from '@/components/SearchInput';

export function MobileSearchPage() {
  usePageTitle('Search - Companion Intelligence');

  return (
    <PageContent>
      <div className="flex flex-col justify-end min-h-full">
        <div className="flex-1" />
        <SearchInput />
        <Actions />
      </div>
    </PageContent>
  );
}

function Actions() {
  return (
    <div className="flex flex-col flex-1 justify-end">
      <div className="grid grid-cols-2 gap-4 p-3">
        <Button variant="secondary" className="w-full justify-center p-6" asChild>
          <Link to="/chat">
            <MessagesSquare className="h-5 w-5" />
            Chats
          </Link>
        </Button>

        <Button variant="secondary" className="w-full justify-center p-6" asChild>
          <Link to="/files">
            <BookImage className="h-5 w-5" />
            Content
          </Link>
        </Button>

        <Button variant="secondary" className="w-full justify-center p-6" asChild>
          <Link to="/memory">
            <Brain className="h-5 w-5" />
            Memory
          </Link>
        </Button>

        <Button variant="secondary" className="w-full justify-center p-6" asChild>
          <Link to="/insights">
            <Lightbulb className="h-5 w-5" />
            Insights
          </Link>
        </Button>
      </div>
    </div>
  );
}
