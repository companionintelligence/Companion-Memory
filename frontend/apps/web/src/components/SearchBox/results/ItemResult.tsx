import { ItemIcon } from '@/components/icons';
import { gql, useFragment, type FragmentType } from '@/graphql';

import { SearchResultRow } from './SearchResultRow';

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

  return <SearchResultRow icon={<ItemIcon />} title={data.name} kind="Thing" />;
}
