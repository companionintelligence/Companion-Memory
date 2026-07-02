import { usePageTitle } from '@ci/common';
import { Button } from '@ci/shadcn';
import { Brain, Lightbulb, MessagesSquare } from '@ci/shadcn/icons';
import { Link } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
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
  const { isFeatureEnabled } = useFeatures();

  return (
    <div className="flex flex-col flex-1 justify-end">
      <div className="grid grid-cols-2 gap-4 p-3">
        <Button variant="secondary" className="w-full justify-center p-6" asChild>
          <Link to="/memory">
            <MessagesSquare className="h-4 w-4" />
            Chats
          </Link>
        </Button>

        <Button variant="secondary" className="w-full justify-center p-6" asChild>
          <Link to="/memory">
            <Brain className="h-4 w-4" />
            Memory
          </Link>
        </Button>

        {isFeatureEnabled('insights.page') && (
          <Button variant="secondary" className="w-full justify-center p-6" asChild>
            <Link to="/insights">
              <Lightbulb className="h-4 w-4" />
              Insights
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}
