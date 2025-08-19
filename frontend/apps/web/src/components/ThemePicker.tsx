import { useState } from 'react';

import { Button, Card, Separator, Tabs } from '@ci/shadcn';
import { Palette, Settings2 } from '@ci/shadcn/icons';

import { useTheme, PRESET_THEMES } from '@/hooks/use-theme';

import { ColorWheel } from './ColorWheel';

export function ThemePicker() {
  const { themeState, setColorTheme, setCustomColor } = useTheme();
  const [customHue, setCustomHue] = useState(themeState.colorTheme.baseHue);

  const handlePresetSelect = (preset: (typeof PRESET_THEMES)[0]) => {
    setColorTheme(preset);
  };

  const handleCustomColorChange = (hue: number) => {
    setCustomHue(hue);
  };

  const handleCustomColorApply = (hue: number) => {
    setCustomColor(hue);
  };

  const isCustomSelected = themeState.colorTheme.isCustom;
  const isPresetSelected = (preset: (typeof PRESET_THEMES)[0]) =>
    !isCustomSelected && preset.baseHue === themeState.colorTheme.baseHue;

  return (
    <Card className="w-full max-w-md">
      <Tabs defaultValue="presets" className="w-full">
        <Tabs.List className="grid w-full grid-cols-2">
          <Tabs.Trigger value="presets" className="flex items-center gap-2">
            <Palette className="h-4 w-4" />
            Presets
          </Tabs.Trigger>
          <Tabs.Trigger value="custom" className="flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Custom
          </Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="presets" className="p-4 space-y-4">
          <div className="space-y-3">
            <h3 className="text-sm font-medium">Choose a color theme</h3>
            <div className="grid grid-cols-3 gap-2">
              {PRESET_THEMES.map((preset) => (
                <button
                  key={preset.name}
                  onClick={() => handlePresetSelect(preset)}
                  className={`
                    group relative aspect-square rounded-md border-2 transition-all
                    ${
                      isPresetSelected(preset)
                        ? 'border-primary ring-2 ring-primary/20'
                        : 'border-border hover:border-primary/50'
                    }
                  `}
                  title={preset.name}
                >
                  {/* Color preview gradient */}
                  <div
                    className="absolute inset-0.5 rounded-sm"
                    style={{
                      background:
                        preset.baseHue === -1
                          ? 'linear-gradient(135deg, #2a2a2a, #3a3a3a, #4a4a4a)' // Lighter dark gray
                          : preset.baseHue === -2
                            ? 'linear-gradient(135deg, #fafafa, #f0f0f0, #e0e0e0)' // Lighter light gray
                            : preset.baseHue === -3
                              ? 'linear-gradient(135deg, #129, #208, #279)' // Original blue theme colors
                              : `linear-gradient(135deg, 
                            oklch(0.3 0.15 ${preset.baseHue}), 
                            oklch(0.5 0.12 ${preset.baseHue}), 
                            oklch(0.7 0.08 ${preset.baseHue})
                          )`,
                    }}
                  />

                  {/* Selection indicator */}
                  {isPresetSelected(preset) && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-2 h-2 bg-white rounded-full border border-gray-300" />
                    </div>
                  )}

                  {/* Hover overlay */}
                  <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity rounded-md" />
                </button>
              ))}
            </div>

            {/* Current preset name */}
            {!isCustomSelected && (
              <div className="text-center pt-2">
                <span className="text-sm text-muted-foreground">{themeState.colorTheme.name}</span>
              </div>
            )}
          </div>
        </Tabs.Content>

        <Tabs.Content value="custom" className="p-4 space-y-4">
          <div className="space-y-4">
            <h3 className="text-sm font-medium">Pick any color</h3>

            <div className="flex justify-center">
              <ColorWheel
                size={180}
                value={customHue < 0 ? 0 : customHue} // Show 0° for neutral themes
                onChange={handleCustomColorChange}
                onChangeEnd={handleCustomColorApply}
              />
            </div>

            <div className="flex gap-2 justify-center">
              <Button
                variant={customHue === -1 ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setCustomHue(-1);
                  setCustomColor(-1);
                }}
                className="text-xs"
              >
                Dark Gray
              </Button>
              <Button
                variant={customHue === -2 ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setCustomHue(-2);
                  setCustomColor(-2);
                }}
                className="text-xs"
              >
                Light Gray
              </Button>
              <Button
                variant={customHue === -3 ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setCustomHue(-3);
                  setCustomColor(-3);
                }}
                className="text-xs"
              >
                Original
              </Button>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm">Preview</span>
                <span className="text-xs text-muted-foreground">
                  {customHue === -1
                    ? 'Dark Gray'
                    : customHue === -2
                      ? 'Light Gray'
                      : customHue === -3
                        ? 'Original'
                        : `${customHue}° HSL`}
                </span>
              </div>

              {/* Color preview swatches */}
              <div className="grid grid-cols-5 gap-2">
                {[
                  { label: 'BG', lightness: 0.129 },
                  { label: 'Card', lightness: 0.208 },
                  { label: 'Secondary', lightness: 0.279 },
                  { label: 'Accent', lightness: 0.4 },
                  { label: 'Primary', lightness: 0.6 },
                ].map((swatch) => (
                  <div key={swatch.label} className="space-y-1">
                    <div
                      className="aspect-square rounded border border-border"
                      style={{
                        backgroundColor:
                          customHue === -1
                            ? `oklch(${swatch.lightness + 0.05} 0 0)` // Lighter pure gray
                            : customHue === -2
                              ? `oklch(${0.9 - swatch.lightness * 0.5} 0.005 60)` // Lighter warm light gray
                              : customHue === -3
                                ? swatch.lightness < 0.3
                                  ? `oklch(${swatch.lightness} 0.042 264)` // Original dark blue shades
                                  : `oklch(${swatch.lightness + 0.4} 0.013 255)` // Original light shades
                                : `oklch(${swatch.lightness} 0.12 ${customHue})`,
                      }}
                    />
                    <div className="text-xs text-center text-muted-foreground">{swatch.label}</div>
                  </div>
                ))}
              </div>

              {isCustomSelected && (
                <div className="text-center pt-2">
                  <span className="text-sm text-muted-foreground">{themeState.colorTheme.name}</span>
                </div>
              )}
            </div>
          </div>
        </Tabs.Content>
      </Tabs>
    </Card>
  );
}
