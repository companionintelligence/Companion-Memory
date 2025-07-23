import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';

type TabsComponent = typeof Tabs & {
  List: typeof TabsList;
  Trigger: typeof TabsTrigger;
  Content: typeof TabsContent;
};

const AugmentedTabs = Tabs as TabsComponent;

AugmentedTabs.List = TabsList;
AugmentedTabs.Trigger = TabsTrigger;
AugmentedTabs.Content = TabsContent;

export { AugmentedTabs as Tabs };
