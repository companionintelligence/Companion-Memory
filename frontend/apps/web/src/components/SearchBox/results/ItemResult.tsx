import { ItemIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

export const ITEM_FRAGMENT = gql(`
  fragment SearchResultItemData on ItemType {
    id
    name
  }
`);

interface Props {
  item: FragmentType<typeof ITEM_FRAGMENT>;
}

export function ItemResult({ item }: Props) {
  const data = useFragment(ITEM_FRAGMENT, item);

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <ItemIcon />
        <div className="font-medium">{data.name}</div>
      </div>
      <div className="text-muted-foreground">Item</div>
    </div>
  );
}
