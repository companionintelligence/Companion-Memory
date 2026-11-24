import { useDeviceLayout } from '@ci/common';
import { Switch } from '@ci/shadcn';

import { ColorPicker, TexturePicker, useBackground, useTheme } from '@/components/ThemePicker';

import { SegmentedControl, SettingsGroup, SettingsRow, SettingsSection } from '../kit';

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
    <SettingsSection title="Appearance" description="Customize the look and feel of your interface.">
      <SettingsGroup>
        <SettingsRow
          label="Theme"
          hint="Auto follows your system setting."
          control={
            <SegmentedControl
              label="Theme"
              value={themeState.mode}
              options={THEME_MODES}
              onChange={setTheme}
              className="w-56"
            />
          }
        />

        {isMobile === false ? (
          <SettingsRow
            label="Pointer glow"
            htmlFor="pointer-glow"
            hint="A soft light that follows the cursor. Desktop only."
            control={
              <Switch
                id="pointer-glow"
                checked={glowEnabled}
                onCheckedChange={setGlowEnabled}
                aria-label="Pointer glow"
              />
            }
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Colors and texture">
        <SettingsRow>
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <ColorPicker />
            </div>
            <div className="border-t border-border pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
              <TexturePicker />
            </div>
          </div>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
