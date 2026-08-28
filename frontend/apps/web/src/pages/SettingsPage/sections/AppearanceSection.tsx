import { useDeviceLayout } from '@ci/common';
import { Card, cn, Label, Switch } from '@ci/shadcn';

import { ColorPicker, TexturePicker, useBackground, useTheme } from '@/components/ThemePicker';

const THEME_MODES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Auto' },
] as const;

export function AppearanceSection() {
  const { themeState, setTheme } = useTheme();
  const { glowEnabled, setGlowEnabled } = useBackground();
  const { isMobile } = useDeviceLayout();

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Appearance</h2>
        <p className="text-sm text-muted-foreground mt-1">Customize the look and feel of your interface.</p>
      </div>

      <Card>
        <Card.Content className="flex flex-col gap-6">
          <div>
            <p className="mb-2 text-sm font-medium">Theme</p>
            <div role="radiogroup" aria-label="Theme" className="flex gap-1 rounded-md bg-muted p-1 text-xs">
              {THEME_MODES.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  role="radio"
                  aria-checked={themeState.mode === entry.value}
                  onClick={() => setTheme(entry.value)}
                  className={cn(
                    'flex-1 cursor-pointer rounded-sm px-2 py-1.5 transition-colors',
                    themeState.mode === entry.value
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>

          {isMobile === false ? (
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor="pointer-glow" className="text-sm font-medium">
                  Pointer glow
                </Label>
                <p className="text-xs text-muted-foreground mt-1">
                  A soft light that follows the cursor. Desktop only.
                </p>
              </div>
              <Switch
                id="pointer-glow"
                checked={glowEnabled}
                onCheckedChange={setGlowEnabled}
                aria-label="Pointer glow"
              />
            </div>
          ) : null}

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
