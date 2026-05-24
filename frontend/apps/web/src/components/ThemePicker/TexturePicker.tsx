import { type CSSProperties, useMemo } from 'react';

import { Button } from '@ci/shadcn';

import {
  TEXTURE_PATTERNS,
  buildTextureBackground,
  readTexturePalette,
  DEFAULT_TEXTURE_PALETTE,
  DEFAULT_TEXTURE_ID,
  useBackground,
} from './useBackground';
import { useTheme } from './useTheme';

const TEXTURE_OPACITY_MIN = 0;
const TEXTURE_OPACITY_MAX = 0.8;
const TEXTURE_OPACITY_STEP = 0.05;

export function TexturePicker() {
  const { themeState } = useTheme();
  const { backgroundState, setTexture, setTextureOpacity } = useBackground();

  const texturePalette = useMemo(
    () => readTexturePalette() ?? DEFAULT_TEXTURE_PALETTE,
    [themeState.mode, themeState.colorTheme],
  );
  const textureOpacity = backgroundState.textureOpacity;

  const texturePreviews = useMemo<Record<string, CSSProperties>>(() => {
    return Object.fromEntries(
      TEXTURE_PATTERNS.map((pattern) => {
        const image = buildTextureBackground(pattern.id, texturePalette, textureOpacity, {
          preview: true,
        });

        return [
          pattern.id,
          {
            backgroundImage: image === 'none' ? undefined : image,
            backgroundSize: pattern.size,
            backgroundRepeat: pattern.repeat ?? 'repeat',
            backgroundColor: texturePalette.background,
          },
        ];
      }),
    );
  }, [texturePalette, textureOpacity]);

  const selectedTexture = TEXTURE_PATTERNS.find((pattern) => pattern.id === backgroundState.textureId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Surface Texture</h3>
          <p className="text-xs text-muted-foreground">Hero-inspired SVG patterns</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setTexture(DEFAULT_TEXTURE_ID)}
          disabled={backgroundState.textureId === DEFAULT_TEXTURE_ID}
          className="text-xs"
        >
          Clear
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {TEXTURE_PATTERNS.map((pattern) => {
          const isSelected = pattern.id === backgroundState.textureId;
          const styles = texturePreviews[pattern.id] ?? {
            backgroundColor: texturePalette.background,
          };

          return (
            <button
              key={pattern.id}
              onClick={() => setTexture(pattern.id)}
              className={`
                  group relative rounded-lg border p-2 text-left transition-all focus-visible:outline-none
                  ${
                    isSelected
                      ? 'border-primary ring-2 ring-primary/30'
                      : 'border-border hover:border-primary/40'
                  }
                `}
              title={pattern.description}
            >
              <div
                className="aspect-square w-full rounded-md border border-border overflow-hidden"
                style={styles}
              />
              <div className="mt-2 text-xs font-medium text-foreground">{pattern.name}</div>
            </button>
          );
        })}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Texture opacity</span>
          <span>{Math.round(textureOpacity * 100)}%</span>
        </div>
        <input
          type="range"
          min={TEXTURE_OPACITY_MIN}
          max={TEXTURE_OPACITY_MAX}
          step={TEXTURE_OPACITY_STEP}
          value={textureOpacity}
          onChange={(event) => setTextureOpacity(parseFloat(event.target.value))}
          className="w-full"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>Subtle</span>
          <span>Bold</span>
        </div>
      </div>

      {selectedTexture && (
        <p className="text-xs text-muted-foreground text-center">{selectedTexture.description}</p>
      )}
    </div>
  );
}
