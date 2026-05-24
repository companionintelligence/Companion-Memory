import { useState, useMemo, useEffect, useRef } from 'react';

import { Button, Tabs, ScrollArea, Input, Label, Popover } from '@ci/shadcn';
import { Palette, Settings2, Sliders, RotateCcw, X, Download, Upload, Copy, Check } from '@ci/shadcn/icons';

import { useFeatures } from '@/common/feature';

import { ColorWheel } from './ColorWheel';
import {
  PRESET_THEMES,
  useTheme,
  COLOR_VARIABLE_CATEGORIES,
  type ThemeColorVariable,
  type ShareableTheme,
} from './useTheme';

interface ColorSwatchEditorProps {
  variable: ThemeColorVariable;
  currentColor: string | undefined;
  hasOverride: boolean;
  onColorChange: (color: string) => void;
  onClear: () => void;
}

function ColorSwatchEditor({
  variable,
  currentColor,
  hasOverride,
  onColorChange,
  onClear,
}: ColorSwatchEditorProps) {
  const [localColor, setLocalColor] = useState(currentColor ?? '');
  const [isOpen, setIsOpen] = useState(false);

  const handleInputChange = (value: string) => {
    setLocalColor(value);
  };

  const handleApply = () => {
    if (localColor.trim()) {
      onColorChange(localColor.trim());
    }

    setIsOpen(false);
  };

  const handleClear = () => {
    onClear();
    setLocalColor('');
    setIsOpen(false);
  };

  // Format variable name for display
  const displayName = variable
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger asChild>
        <button className="group relative flex items-center gap-2 p-2 rounded-md border transition-all text-left w-full">
          <div
            className="w-6 h-6 rounded border border-border shrink-0"
            style={{ backgroundColor: currentColor ?? 'transparent' }}
          />
          <span className="text-xs truncate flex-1">{displayName}</span>
          {hasOverride && (
            <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" title="Custom override" />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Content className="w-72 p-3 z-[1001]" align="start" sideOffset={5}>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">{displayName}</Label>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setIsOpen(false)}>
              <X className="h-3 w-3" />
            </Button>
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Current value</Label>
            <div className="flex items-center gap-2">
              <div
                className="w-8 h-8 rounded border border-border shrink-0"
                style={{ backgroundColor: currentColor ?? 'transparent' }}
              />
              <code className="text-xs bg-muted px-2 py-1 rounded flex-1 truncate">
                {currentColor ?? 'not set'}
              </code>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Custom color (oklch, hsl, rgb, hex)</Label>
            <Input
              type="text"
              placeholder="oklch(0.5 0.1 250) or #ff0000"
              value={localColor}
              onChange={(e) => handleInputChange(e.target.value)}
              className="text-xs font-mono"
            />
          </div>

          <div className="flex gap-2">
            <Button size="sm" onClick={handleApply} disabled={!localColor.trim()} className="flex-1">
              Apply
            </Button>
            {hasOverride && (
              <Button size="sm" variant="outline" onClick={handleClear}>
                <RotateCcw className="h-3 w-3 mr-1" />
                Reset
              </Button>
            )}
          </div>
        </div>
      </Popover.Content>
    </Popover>
  );
}

export function ColorPicker() {
  const {
    themeState,
    setColorTheme,
    setCustomColor,
    setColorVariable,
    clearColorVariable,
    clearAllColorOverrides,
    getEffectiveColor,
    exportTheme,
    importTheme,
  } = useTheme();
  const [customHue, setCustomHue] = useState(themeState.colorTheme.baseHue);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync customHue when the theme changes (e.g., when a preset is selected)
  useEffect(() => {
    setCustomHue(themeState.colorTheme.baseHue);
  }, [themeState.colorTheme.baseHue]);

  const handleExportToClipboard = async () => {
    const theme = exportTheme();
    const json = JSON.stringify(theme, null, 2);
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExportToFile = () => {
    const theme = exportTheme();
    const json = JSON.stringify(theme, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${theme.name.toLowerCase().replace(/\s+/g, '-')}-theme.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImportFromFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = e.target?.result as string;
        const theme = JSON.parse(json) as ShareableTheme;
        importTheme(theme);
      } catch (error) {
        console.error('Failed to parse theme file:', error);
      }
    };

    reader.readAsText(file);
    // Reset input so same file can be selected again
    event.target.value = '';
  };

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

  const overrideCount = useMemo(
    () => Object.keys(themeState.colorOverrides).length,
    [themeState.colorOverrides],
  );

  const { isFeatureEnabled } = useFeatures();
  const showAdvancedTab = isFeatureEnabled('advanced.theme.tab');

  return (
    <Tabs defaultValue="presets" className="w-full">
      <Tabs.List className={`grid w-full ${showAdvancedTab ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <Tabs.Trigger value="presets" className="flex items-center gap-1 text-xs">
          <Palette className="h-3.5 w-3.5" />
          Presets
        </Tabs.Trigger>
        <Tabs.Trigger value="custom" className="flex items-center gap-1 text-xs">
          <Settings2 className="h-3.5 w-3.5" />
          Custom
        </Tabs.Trigger>
        {showAdvancedTab && (
          <Tabs.Trigger value="advanced" className="flex items-center gap-1 text-xs">
            <Sliders className="h-3.5 w-3.5" />
            Advanced
            {overrideCount > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-[10px] bg-primary text-primary-foreground rounded-full">
                {overrideCount}
              </span>
            )}
          </Tabs.Trigger>
        )}
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
                <div
                  className="absolute inset-0.5 rounded-sm"
                  style={{
                    background:
                      preset.baseHue === -1
                        ? 'linear-gradient(135deg, #2a2a2a, #3a3a3a, #4a4a4a)'
                        : preset.baseHue === -2
                          ? 'linear-gradient(135deg, #fafafa, #f0f0f0, #e0e0e0)'
                          : preset.baseHue === -3
                            ? 'linear-gradient(135deg, #129, #208, #279)'
                            : `linear-gradient(135deg,
                            oklch(0.3 0.15 ${preset.baseHue}),
                            oklch(0.5 0.12 ${preset.baseHue}),
                            oklch(0.7 0.08 ${preset.baseHue})
                          )`,
                  }}
                />

                {isPresetSelected(preset) && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-2 h-2 bg-white rounded-full border border-gray-300" />
                  </div>
                )}

                <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity rounded-md" />
              </button>
            ))}
          </div>

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
              value={customHue < 0 ? 0 : customHue}
              onChange={handleCustomColorChange}
              onChangeEnd={handleCustomColorApply}
            />
          </div>

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

            <div className="grid grid-cols-5 gap-2">
              {[
                { label: 'Dark', lightness: 0.25, chroma: 0.08 },
                { label: 'Mid', lightness: 0.45, chroma: 0.12 },
                { label: 'Base', lightness: 0.6, chroma: 0.15 },
                { label: 'Light', lightness: 0.75, chroma: 0.12 },
                { label: 'Pale', lightness: 0.9, chroma: 0.06 },
              ].map((swatch) => (
                <div key={swatch.label} className="space-y-1">
                  <div
                    className="aspect-square rounded border border-border"
                    style={{
                      backgroundColor:
                        customHue === -1
                          ? `oklch(${swatch.lightness} 0 0)`
                          : customHue === -2
                            ? `oklch(${swatch.lightness} 0.005 60)`
                            : customHue === -3
                              ? `oklch(${swatch.lightness} 0.042 264)`
                              : `oklch(${swatch.lightness} ${swatch.chroma} ${customHue})`,
                    }}
                  />
                  <div className="text-xs text-center text-muted-foreground">{swatch.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Tabs.Content>

      {showAdvancedTab && (
        <Tabs.Content value="advanced" className="p-4 space-y-4">
          <div className="space-y-4">
            {/* Export/Import Section */}
            <div className="space-y-2">
              <h3 className="text-sm font-medium">Share theme</h3>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleExportToClipboard} className="flex-1">
                  {copied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                  {copied ? 'Copied!' : 'Copy'}
                </Button>
                <Button variant="outline" size="sm" onClick={handleExportToFile} className="flex-1">
                  <Download className="h-3 w-3 mr-1" />
                  Export
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1"
                >
                  <Upload className="h-3 w-3 mr-1" />
                  Import
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleImportFromFile}
                  className="hidden"
                />
              </div>
            </div>

            <div className="border-t pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-medium">Color variables</h3>
                  <p className="text-xs text-muted-foreground">Override individual theme colors</p>
                </div>
                {overrideCount > 0 && (
                  <Button variant="ghost" size="sm" onClick={clearAllColorOverrides} className="text-xs">
                    <RotateCcw className="h-3 w-3 mr-1" />
                    Reset all
                  </Button>
                )}
              </div>
            </div>

            <ScrollArea className="h-[450px] px-6 -mx-6 -mb-4">
              <div className="space-y-4 pb-4">
                {Object.entries(COLOR_VARIABLE_CATEGORIES).map(([category, variables]) => (
                  <div key={category} className="space-y-2">
                    <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      {category}
                    </h4>
                    <div className="grid grid-cols-2 gap-2">
                      {variables.map((variable) => {
                        const typedVariable = variable as ThemeColorVariable;
                        const hasOverride = typedVariable in themeState.colorOverrides;
                        const effectiveColor = getEffectiveColor(typedVariable);

                        return (
                          <ColorSwatchEditor
                            key={typedVariable}
                            variable={typedVariable}
                            currentColor={effectiveColor}
                            hasOverride={hasOverride}
                            onColorChange={(color) => setColorVariable(typedVariable, color)}
                            onClear={() => clearColorVariable(typedVariable)}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </Tabs.Content>
      )}
    </Tabs>
  );
}
