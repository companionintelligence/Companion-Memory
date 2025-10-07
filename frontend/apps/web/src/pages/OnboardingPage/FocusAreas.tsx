import { Checkbox, Label } from '@ci/shadcn';

function SelectOption({
  id,
  primaryText,
  secondaryText,
}: {
  id?: string;
  primaryText: string;
  secondaryText: string;
}) {
  return (
    <>
      <Label className="contents cursor-pointer">
        <div className="inline-flex items-center whitespace-nowrap">
          <Checkbox id={id} />
        </div>
        <div className="self-center text-base font-medium">{primaryText}</div>
        <div className="col-start-2 self-center text-muted-foreground text-base font-light">
          {secondaryText}
        </div>
      </Label>
      <div className="col-span-2 h-6 last:hidden"></div>
    </>
  );
}

export function FocusAreas() {
  return (
    <>
      <div className="text-center text-2xl mb-4 md:mb-10">Your focus areas</div>
      <div className="grid grid-cols-[max-content_1fr] items-center gap-x-3">
        <SelectOption
          primaryText="Personal fitness and health"
          secondaryText="Track workouts, monitor progress, and build habits that support long-term physical wellbeing"
        />
        <SelectOption
          primaryText="Nutrition and meal planning"
          secondaryText="Plan meals, organize grocery lists, and align food choices with your health goals"
        />
        <SelectOption
          primaryText="Communication management"
          secondaryText="Centralize messages, schedule conversations, and keep track of important interactions"
        />
        <SelectOption
          primaryText="Entertainment and activities"
          secondaryText="Organize hobbies, events, and downtime to bring balance and enjoyment to your schedule"
        />
        <SelectOption
          primaryText="Travel planning"
          secondaryText="Manage itineraries, bookings, and logistics to make trips easier from start to finish"
        />
      </div>
    </>
  );
}
