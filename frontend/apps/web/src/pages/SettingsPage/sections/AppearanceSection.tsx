import { Card } from '@ci/shadcn';

import { ColorPicker, TexturePicker } from '@/components/ThemePicker';

export function AppearanceSection() {
  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Appearance</h2>
        <p className="text-sm text-muted-foreground mt-1">Customize the look and feel of your interface.</p>
      </div>

      <Card>
        <Card.Content>
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <ColorPicker />
            </div>
            <div className="border-t border-border pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
              <TexturePicker />
            </div>
          </div>
        </Card.Content>
      </Card>
    </>
  );
}
