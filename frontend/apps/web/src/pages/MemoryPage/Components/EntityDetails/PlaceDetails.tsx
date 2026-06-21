import { Input, Label, Sheet } from '@ci/shadcn';

import { PLACE_FRAGMENT } from '@/components/entities/grid/PlaceGridItem';
import { useFragment, type FragmentType } from '@/graphql';

interface Props {
  entity: FragmentType<typeof PLACE_FRAGMENT>;
}

type PlaceProperties = {
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export function PlaceDetails({ entity }: Props) {
  const data = useFragment(PLACE_FRAGMENT, entity);
  const properties = (data.properties ?? {}) as PlaceProperties;

  const hasCoordinates = properties.latitude != null && properties.longitude != null;

  return (
    <Sheet.Content className="z-index-1000">
      <Sheet.Header>
        <Sheet.Title>{data.name || 'Place'}</Sheet.Title>
        {data.description && <Sheet.Description>{data.description}</Sheet.Description>}
      </Sheet.Header>
      <div className="grid flex-1 auto-rows-min gap-6 px-4">
        {properties.address && (
          <div className="grid gap-3">
            <Label htmlFor="address">Address</Label>
            <Input id="address" disabled defaultValue={properties.address} />
          </div>
        )}
        {hasCoordinates && (
          <div className="grid gap-3">
            <Label htmlFor="coordinates">Coordinates</Label>
            <Input
              id="coordinates"
              disabled
              defaultValue={`Latitude: ${properties.latitude}, Longitude: ${properties.longitude}`}
            />
          </div>
        )}
      </div>
    </Sheet.Content>
  );
}
