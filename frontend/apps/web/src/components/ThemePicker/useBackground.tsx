import { createContext, useContext, useEffect, useState } from 'react';

interface TexturePalette {
  background: string;
  accent: string;
  contrast: string;
  muted: string;
}

export const DEFAULT_TEXTURE_PALETTE: TexturePalette = {
  background: 'oklch(0.129 0 0)',
  accent: 'oklch(0.65 0.1 250)',
  contrast: 'oklch(0.95 0 0)',
  muted: 'oklch(0.4 0 0)',
};

interface TexturePattern {
  id: string;
  name: string;
  description: string;
  size: string;
  repeat?: string;
  blendMode?: string;
  attachment?: 'fixed' | 'local';
  build: (palette: TexturePalette, opacity: number) => string | string[];
  isDynamic?: boolean;
}

interface BackgroundState {
  textureId: string;
  textureOpacity: number;
}

type BackgroundProviderProps = {
  children: React.ReactNode;
  defaultTextureId?: string;
  defaultTextureOpacity?: number;
  textureStorageKey?: string;
  textureOpacityStorageKey?: string;
};

type BackgroundProviderState = {
  backgroundState: BackgroundState;
  setTexture: (textureId: string) => void;
  setTextureOpacity: (opacity: number) => void;
};

export const DEFAULT_TEXTURE_ID = 'none';

const svgTexture = (svg: string) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const formatOpacity = (value: number) => clamp01(value).toFixed(3);

const CONWAY_TEXTURE_ID = 'conway-life';
const CONWAY_GRID_SIZE = 48;
const CONWAY_CELL_SIZE = 6;
const CONWAY_PATTERN_PX = CONWAY_GRID_SIZE * CONWAY_CELL_SIZE;
const CONWAY_TICK_MS = 360;

export const TEXTURE_PATTERNS: TexturePattern[] = [
  {
    id: DEFAULT_TEXTURE_ID,
    name: 'None',
    description: 'Solid background only',
    size: 'auto',
    build: () => 'none',
  },
  {
    id: 'micro-dots',
    name: 'Micro Dots',
    description: 'Polka Dots',
    size: '48px 48px',
    build: ({ accent }, opacity) => {
      const alpha = (value: number) => formatOpacity(value * opacity);

      return svgTexture(`
        <svg width="48" height="48" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
          <circle cx="10" cy="10" r="2.2" fill="${accent}" fill-opacity="${alpha(0.14)}" />
          <circle cx="34" cy="10" r="2.2" fill="${accent}" fill-opacity="${alpha(0.1)}" />
          <circle cx="22" cy="24" r="2.2" fill="${accent}" fill-opacity="${alpha(0.18)}" />
          <circle cx="46" cy="24" r="2.2" fill="${accent}" fill-opacity="${alpha(0.08)}" />
          <circle cx="10" cy="38" r="2.2" fill="${accent}" fill-opacity="${alpha(0.12)}" />
          <circle cx="34" cy="38" r="2.2" fill="${accent}" fill-opacity="${alpha(0.16)}" />
          <circle cx="-2" cy="24" r="2.2" fill="${accent}" fill-opacity="${alpha(0.1)}" />
        </svg>
      `);
    },
  },
  {
    id: 'cross-hatch',
    name: 'Cross Hatch',
    description: 'Tight grid.',
    size: '64px 64px',
    build: ({ contrast }, opacity) =>
      svgTexture(`
        <svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <path d="M0 16H64M0 32H64M0 48H64" stroke="${contrast}" stroke-opacity="${formatOpacity(0.12 * opacity)}" stroke-width="1.2" />
          <path d="M16 0V64M32 0V64M48 0V64" stroke="${contrast}" stroke-opacity="${formatOpacity(0.12 * opacity)}" stroke-width="1.2" />
        </svg>
      `),
  },
  {
    id: 'diagonal-lines',
    name: 'Diagonal Lines',
    description: 'Classic diagonal stripes.',
    size: '56px 56px',
    build: ({ accent }, opacity) =>
      svgTexture(`
        <svg width="56" height="56" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg">
          <path d="M-14 56L56 -14M-2 56L56 -2M10 56L56 10M22 56L56 22" stroke="${accent}" stroke-opacity="${formatOpacity(0.12 * opacity)}" stroke-width="6" stroke-linecap="round" />
        </svg>
      `),
  },
  {
    id: 'overlapping-circles',
    name: 'Overlapping Circles',
    description: 'Concentric arcs',
    size: '96px 96px',
    build: ({ accent, muted }, opacity) =>
      svgTexture(`
        <svg width="96" height="96" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" fill="none">
          <circle cx="48" cy="48" r="42" stroke="${accent}" stroke-opacity="${formatOpacity(0.08 * opacity)}" stroke-width="1.5" />
          <circle cx="0" cy="48" r="42" stroke="${muted}" stroke-opacity="${formatOpacity(0.12 * opacity)}" stroke-width="1.5" />
          <circle cx="96" cy="48" r="42" stroke="${muted}" stroke-opacity="${formatOpacity(0.12 * opacity)}" stroke-width="1.5" />
          <circle cx="48" cy="0" r="42" stroke="${accent}" stroke-opacity="${formatOpacity(0.08 * opacity)}" stroke-width="1.5" />
          <circle cx="48" cy="96" r="42" stroke="${accent}" stroke-opacity="${formatOpacity(0.08 * opacity)}" stroke-width="1.5" />
        </svg>
      `),
  },
  {
    id: 'isometric-cubes',
    name: 'Isometric Cubes',
    description: 'Geometric tessellation',
    size: '96px 96px',
    build: ({ contrast, accent }, opacity) =>
      svgTexture(`
        <svg width="96" height="96" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" fill="none">
          <path d="M16 32L32 16L48 32L32 48L16 32Z" stroke="${contrast}" stroke-opacity="${formatOpacity(0.18 * opacity)}" stroke-width="1" />
          <path d="M48 32L64 16L80 32L64 48L48 32Z" stroke="${accent}" stroke-opacity="${formatOpacity(0.14 * opacity)}" stroke-width="1" />
          <path d="M32 48L48 32L64 48L48 64L32 48Z" stroke="${contrast}" stroke-opacity="${formatOpacity(0.18 * opacity)}" stroke-width="1" />
          <path d="M0 32L16 16L32 32L16 48L0 32Z" stroke="${accent}" stroke-opacity="${formatOpacity(0.16 * opacity)}" stroke-width="1" />
          <path d="M64 48L80 32L96 48L80 64L64 48Z" stroke="${accent}" stroke-opacity="${formatOpacity(0.16 * opacity)}" stroke-width="1" />
          <path d="M32 16L48 0L64 16L48 32L32 16Z" stroke="${accent}" stroke-opacity="${formatOpacity(0.14 * opacity)}" stroke-width="1" />
          <path d="M32 64L48 48L64 64L48 80L32 64Z" stroke="${contrast}" stroke-opacity="${formatOpacity(0.18 * opacity)}" stroke-width="1" />
        </svg>
      `),
  },
  {
    id: 'contour-lines',
    name: 'Contour Lines',
    description: 'Organic waves',
    size: '160px 160px',
    build: ({ contrast }, opacity) =>
      svgTexture(`
        <svg width="160" height="160" viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg" fill="none">
          <path d="M-10 40C30 20 70 20 110 40C150 60 190 60 230 40" stroke="${contrast}" stroke-opacity="${formatOpacity(0.08 * opacity)}" stroke-width="1.4" />
          <path d="M-10 80C20 60 80 60 110 80C140 100 200 100 230 80" stroke="${contrast}" stroke-opacity="${formatOpacity(0.12 * opacity)}" stroke-width="1.4" />
          <path d="M-10 120C20 100 80 100 110 120C140 140 200 140 230 120" stroke="${contrast}" stroke-opacity="${formatOpacity(0.08 * opacity)}" stroke-width="1.4" />
          <path d="M-10 0C30 -20 70 -20 110 0C150 20 190 20 230 0" stroke="${contrast}" stroke-opacity="${formatOpacity(0.06 * opacity)}" stroke-width="1.4" />
        </svg>
      `),
  },
  {
    id: 'corner-crosses',
    name: 'Corner Crosses',
    description: 'Cross motifs',
    size: '40px 40px',
    build: ({ accent }, opacity) =>
      svgTexture(`
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
          <g fill-rule="evenodd" fill="${accent}" fill-opacity="${formatOpacity(0.4 * opacity)}">
            <path d="M0 38.59l2.83-2.83 1.41 1.41L1.41 40H0v-1.41z" />
            <path d="M0 1.4l2.83 2.83 1.41-1.41L1.41 0H0v1.41z" />
            <path d="M38.59 40l-2.83-2.83 1.41-1.41L40 38.59V40h-1.41z" />
            <path d="M40 1.41l-2.83 2.83-1.41-1.41L38.59 0H40v1.41z" />
            <path d="M20 18.6l2.83-2.83 1.41 1.41L21.41 20l2.83 2.83-1.41 1.41L20 21.41l-2.83 2.83-1.41-1.41L18.59 20l-2.83-2.83 1.41-1.41L20 18.59z" />
          </g>
        </svg>
      `),
  },
  {
    id: CONWAY_TEXTURE_ID,
    name: "Conway's Life",
    description: 'Animated Game of Life seeded per page refresh.',
    size: `${CONWAY_PATTERN_PX}px ${CONWAY_PATTERN_PX}px`,
    repeat: 'repeat',
    isDynamic: true,
    build: (palette, opacity) => generateConwayPreview(palette, opacity),
  },
];

const resolveTexturePattern = (textureId: string) =>
  TEXTURE_PATTERNS.find((pattern) => pattern.id === textureId) ?? TEXTURE_PATTERNS[0];

const extractPalette = (styles: CSSStyleDeclaration): TexturePalette => {
  const read = (key: string, fallback: string) => styles.getPropertyValue(key).trim() || fallback;

  return {
    background: read('--background', DEFAULT_TEXTURE_PALETTE.background),
    accent: read('--primary', read('--accent', DEFAULT_TEXTURE_PALETTE.accent)),
    contrast: read('--muted-foreground', read('--foreground', DEFAULT_TEXTURE_PALETTE.contrast)),
    muted: read('--muted', read('--secondary', DEFAULT_TEXTURE_PALETTE.muted)),
  };
};

const getPaletteFromRoot = (root: HTMLElement): TexturePalette => {
  const styles = window.getComputedStyle(root);

  return extractPalette(styles);
};

const isBrowser = typeof window !== 'undefined';

const createConwayState = () => new Uint8Array(CONWAY_GRID_SIZE * CONWAY_GRID_SIZE);

const seedConwayState = (state: Uint8Array, density = 0.35) => {
  for (let i = 0; i < state.length; i += 1) {
    state[i] = Math.random() < density ? 1 : 0;
  }
};

const idx = (x: number, y: number) => {
  const wrapX = (x + CONWAY_GRID_SIZE) % CONWAY_GRID_SIZE;
  const wrapY = (y + CONWAY_GRID_SIZE) % CONWAY_GRID_SIZE;

  return wrapY * CONWAY_GRID_SIZE + wrapX;
};

const stepConway = (state: Uint8Array, buffer: Uint8Array) => {
  let activeCells = 0;
  for (let y = 0; y < CONWAY_GRID_SIZE; y += 1) {
    for (let x = 0; x < CONWAY_GRID_SIZE; x += 1) {
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }

          neighbors += state[idx(x + dx, y + dy)];
        }
      }

      const current = state[idx(x, y)];
      const next = neighbors === 3 || (current === 1 && neighbors === 2) ? 1 : 0;
      buffer[idx(x, y)] = next;
      activeCells += next;
    }
  }

  state.set(buffer);

  return activeCells;
};

const drawConwayState = (
  ctx: CanvasRenderingContext2D,
  state: Uint8Array,
  palette: TexturePalette,
  opacity: number,
) => {
  const clampedOpacity = clamp01(opacity);
  const aliveAlpha = clamp01(clampedOpacity * 0.85);
  const gridAlpha = clamp01(clampedOpacity * 0.15);

  ctx.clearRect(0, 0, CONWAY_PATTERN_PX, CONWAY_PATTERN_PX);
  ctx.fillStyle = palette.background;
  ctx.fillRect(0, 0, CONWAY_PATTERN_PX, CONWAY_PATTERN_PX);

  if (gridAlpha > 0) {
    ctx.strokeStyle = palette.muted;
    ctx.globalAlpha = gridAlpha;
    for (let i = 0; i <= CONWAY_GRID_SIZE; i += 1) {
      const offset = i * CONWAY_CELL_SIZE;
      ctx.beginPath();
      ctx.moveTo(offset, 0);
      ctx.lineTo(offset, CONWAY_PATTERN_PX);
      ctx.moveTo(0, offset);
      ctx.lineTo(CONWAY_PATTERN_PX, offset);
      ctx.stroke();
    }
  }

  if (aliveAlpha > 0) {
    ctx.globalAlpha = aliveAlpha;
    ctx.fillStyle = palette.accent;
    const cellSize = Math.max(1, CONWAY_CELL_SIZE - 1);
    for (let y = 0; y < CONWAY_GRID_SIZE; y += 1) {
      for (let x = 0; x < CONWAY_GRID_SIZE; x += 1) {
        if (state[idx(x, y)] === 1) {
          ctx.fillRect(x * CONWAY_CELL_SIZE, y * CONWAY_CELL_SIZE, cellSize, cellSize);
        }
      }
    }
  }

  ctx.globalAlpha = 1;
};

function generateConwayPreview(palette: TexturePalette, opacity: number) {
  if (!isBrowser) {
    return 'none';
  }

  const canvas = document.createElement('canvas');
  canvas.width = CONWAY_PATTERN_PX;
  canvas.height = CONWAY_PATTERN_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return 'none';
  }

  const state = createConwayState();
  const buffer = createConwayState();
  seedConwayState(state);
  for (let i = 0; i < 4; i += 1) {
    const active = stepConway(state, buffer);
    if (active === 0) {
      seedConwayState(state);
    }
  }

  drawConwayState(ctx, state, palette, opacity);

  return `url(${canvas.toDataURL('image/png')})`;
}

interface DynamicTextureController {
  start: (root: HTMLElement, palette: TexturePalette, opacity: number) => void;
  stop: () => void;
}

class ConwayLifeAnimator implements DynamicTextureController {
  private canvas: HTMLCanvasElement | null = null;

  private ctx: CanvasRenderingContext2D | null = null;

  private state: Uint8Array = createConwayState();

  private buffer: Uint8Array = createConwayState();

  private timer: number | null = null;

  private palette: TexturePalette = DEFAULT_TEXTURE_PALETTE;

  private opacity = 0.35;

  private root: HTMLElement | null = null;

  constructor() {
    if (isBrowser) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = CONWAY_PATTERN_PX;
      this.canvas.height = CONWAY_PATTERN_PX;
      this.ctx = this.canvas.getContext('2d');
    }
  }

  start(root: HTMLElement, palette: TexturePalette, opacity: number) {
    if (!isBrowser || !this.canvas || !this.ctx) {
      return;
    }

    this.stop();
    this.root = root;
    this.palette = palette;
    this.opacity = opacity;
    seedConwayState(this.state);
    this.drawAndApply();
    this.timer = window.setInterval(() => {
      const active = stepConway(this.state, this.buffer);
      if (active === 0) {
        seedConwayState(this.state);
      }

      this.drawAndApply();
    }, CONWAY_TICK_MS);
  }

  stop() {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = null;
    }

    this.root = null;
  }

  private drawAndApply() {
    if (!this.canvas || !this.ctx || !this.root) {
      return;
    }

    drawConwayState(this.ctx, this.state, this.palette, this.opacity);
    const dataUrl = this.canvas.toDataURL('image/png');
    this.root.style.setProperty('--texture-image', `url(${dataUrl})`);
  }
}

const dynamicTextureControllers: Record<string, DynamicTextureController> = {
  [CONWAY_TEXTURE_ID]: new ConwayLifeAnimator(),
};

const stopDynamicTextures = (excludeId?: string) => {
  Object.entries(dynamicTextureControllers).forEach(([id, controller]) => {
    if (excludeId && id === excludeId) {
      return;
    }

    controller.stop();
  });
};

const applyTextureToRoot = (root: HTMLElement, textureId: string, opacity: number) => {
  const texture = resolveTexturePattern(textureId);
  const normalizedOpacity = clamp01(opacity);

  if (texture.id === DEFAULT_TEXTURE_ID) {
    stopDynamicTextures();
    root.style.removeProperty('--texture-image');
    root.style.removeProperty('--texture-size');
    root.style.removeProperty('--texture-repeat');
    root.style.removeProperty('--texture-attachment');
    root.style.removeProperty('--texture-blend-mode');

    return;
  }

  const palette = getPaletteFromRoot(root);
  const controller = dynamicTextureControllers[texture.id];

  root.style.setProperty('--texture-size', texture.size);
  root.style.setProperty('--texture-repeat', texture.repeat ?? 'repeat');
  root.style.setProperty('--texture-attachment', texture.attachment ?? 'local');

  if (controller) {
    stopDynamicTextures(texture.id);
    controller.start(root, palette, normalizedOpacity);
    if (texture.blendMode) {
      root.style.setProperty('--texture-blend-mode', texture.blendMode);
    } else {
      root.style.removeProperty('--texture-blend-mode');
    }

    return;
  }

  stopDynamicTextures();

  const layers = texture.build(palette, normalizedOpacity);
  const image = Array.isArray(layers) ? layers.join(', ') : layers;

  if (!image || image === 'none') {
    root.style.removeProperty('--texture-image');
    root.style.removeProperty('--texture-size');
    root.style.removeProperty('--texture-repeat');
    root.style.removeProperty('--texture-attachment');
    root.style.removeProperty('--texture-blend-mode');

    return;
  }

  root.style.setProperty('--texture-image', image);

  if (texture.blendMode) {
    root.style.setProperty('--texture-blend-mode', texture.blendMode);
  } else {
    root.style.removeProperty('--texture-blend-mode');
  }
};

export const readTexturePalette = (): TexturePalette | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  return getPaletteFromRoot(window.document.documentElement);
};

export const buildTextureBackground = (
  textureId: string,
  palette: TexturePalette,
  opacity: number,
  options: { preview?: boolean } = {},
) => {
  const texture = resolveTexturePattern(textureId);
  if (texture.id === DEFAULT_TEXTURE_ID) {
    return 'none';
  }

  if (texture.isDynamic && !options.preview) {
    return 'none';
  }

  const layers = texture.build(palette, clamp01(opacity));

  return Array.isArray(layers) ? layers.join(', ') : layers;
};

const initialState: BackgroundProviderState = {
  backgroundState: {
    textureId: DEFAULT_TEXTURE_ID,
    textureOpacity: 0.35,
  },
  setTexture: () => null,
  setTextureOpacity: () => null,
};

const BackgroundProviderContext = createContext<BackgroundProviderState>(initialState);

export function BackgroundProvider({
  children,
  defaultTextureId = DEFAULT_TEXTURE_ID,
  defaultTextureOpacity = 0.35,
  textureStorageKey = 'ci-ui-texture',
  textureOpacityStorageKey = 'ci-ui-texture-opacity',
}: BackgroundProviderProps) {
  const [backgroundState, setBackgroundState] = useState<BackgroundState>(() => {
    const storedTexture = localStorage.getItem(textureStorageKey);
    const storedTextureOpacity = localStorage.getItem(textureOpacityStorageKey);

    const resolvedTexture = resolveTexturePattern(storedTexture || defaultTextureId);
    const resolvedOpacity = (() => {
      if (!storedTextureOpacity) {
        return clamp01(defaultTextureOpacity);
      }

      const parsed = Number(storedTextureOpacity);

      return Number.isFinite(parsed) ? clamp01(parsed) : clamp01(defaultTextureOpacity);
    })();

    return {
      textureId: resolvedTexture.id,
      textureOpacity: resolvedOpacity,
    };
  });

  useEffect(() => {
    const root = window.document.documentElement;
    applyTextureToRoot(root, backgroundState.textureId, backgroundState.textureOpacity);
  }, [backgroundState]);

  const setTexture = (textureId: string) => {
    const resolved = resolveTexturePattern(textureId).id;
    localStorage.setItem(textureStorageKey, resolved);
    setBackgroundState((prev) => ({ ...prev, textureId: resolved }));
  };

  const setTextureOpacity = (opacity: number) => {
    const normalized = clamp01(opacity);
    localStorage.setItem(textureOpacityStorageKey, normalized.toString());
    setBackgroundState((prev) => ({ ...prev, textureOpacity: normalized }));
  };

  const value = {
    backgroundState,
    setTexture,
    setTextureOpacity,
  };

  return <BackgroundProviderContext.Provider value={value}>{children}</BackgroundProviderContext.Provider>;
}

export const useBackground = () => {
  const context = useContext(BackgroundProviderContext);

  if (context === undefined) {
    throw new Error('useBackground must be used within a BackgroundProvider');
  }

  return context;
};
