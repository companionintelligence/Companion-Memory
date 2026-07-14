import { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'dark' | 'light' | 'system';

interface ColorTheme {
  name: string;
  baseHue: number;
  isCustom?: boolean;
}

// All available theme color variable names
export type ThemeColorVariable =
  | 'background'
  | 'foreground'
  | 'card'
  | 'card-foreground'
  | 'popover'
  | 'popover-foreground'
  | 'primary'
  | 'primary-foreground'
  | 'secondary'
  | 'secondary-foreground'
  | 'muted'
  | 'muted-foreground'
  | 'accent'
  | 'accent-foreground'
  | 'destructive'
  | 'border'
  | 'input'
  | 'ring'
  | 'chart-1'
  | 'chart-2'
  | 'chart-3'
  | 'chart-4'
  | 'chart-5'
  | 'sidebar'
  | 'sidebar-foreground'
  | 'sidebar-primary'
  | 'sidebar-primary-foreground'
  | 'sidebar-accent'
  | 'sidebar-accent-foreground'
  | 'sidebar-border'
  | 'sidebar-ring';

export const THEME_COLOR_VARIABLES: ThemeColorVariable[] = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
];

// Color variable categories for UI organization
export const COLOR_VARIABLE_CATEGORIES = {
  'Core Colors': ['background', 'foreground', 'primary', 'primary-foreground'],
  'Surface Colors': ['card', 'card-foreground', 'popover', 'popover-foreground'],
  'Secondary Colors': ['secondary', 'secondary-foreground', 'muted', 'muted-foreground'],
  'Accent Colors': ['accent', 'accent-foreground', 'destructive'],
  'Form Colors': ['border', 'input', 'ring'],
  'Chart Colors': ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5'],
  'Sidebar Colors': [
    'sidebar',
    'sidebar-foreground',
    'sidebar-primary',
    'sidebar-primary-foreground',
    'sidebar-accent',
    'sidebar-accent-foreground',
    'sidebar-border',
    'sidebar-ring',
  ],
} as const;

// Custom color overrides - allows setting specific variables to specific colors
export type ColorOverrides = Partial<Record<ThemeColorVariable, string>>;

// Shareable theme format for export/import
export interface ShareableTheme {
  version: 1;
  name: string;
  colorTheme: ColorTheme;
  colorOverrides: ColorOverrides;
  exportedAt: string;
}

interface ThemeState {
  mode: Theme;
  colorTheme: ColorTheme;
  colorOverrides: ColorOverrides;
}

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  defaultColorTheme?: ColorTheme;
  storageKey?: string;
  colorStorageKey?: string;
  colorOverridesStorageKey?: string;
};

type ThemeProviderState = {
  themeState: ThemeState;
  setTheme: (theme: Theme) => void;
  setColorTheme: (colorTheme: ColorTheme) => void;
  exportTheme: (name?: string) => ShareableTheme;
  importTheme: (theme: ShareableTheme) => boolean;
  setCustomColor: (hue: number) => void;
  setColorVariable: (variable: ThemeColorVariable, color: string) => void;
  clearColorVariable: (variable: ThemeColorVariable) => void;
  clearAllColorOverrides: () => void;
  getEffectiveColor: (variable: ThemeColorVariable) => string | undefined;
};

// Preset color themes
export const PRESET_THEMES: ColorTheme[] = [
  { name: 'Original', baseHue: -3 }, // Special value for original theme
  { name: 'Light Gray', baseHue: -2 }, // Special value for light neutral
  { name: 'Dark Gray', baseHue: -1 }, // Special value for dark neutral
  { name: 'Crimson Red', baseHue: 0 },
  { name: 'Sunset Orange', baseHue: 30 },
  { name: 'Forest Green', baseHue: 120 },
  { name: 'Midnight Indigo', baseHue: 240 },
  { name: 'Ocean Blue', baseHue: 260 },
  { name: 'Velvety Purple', baseHue: 280 },
];

// Generate theme colors based on base hue and mode
function generateThemeColors(baseHue: number, isDark: boolean = true): Record<string, string> {
  // Handle special neutral themes
  if (baseHue === -1) {
    // Dark Gray theme (lighter than before)
    return generateNeutralTheme(isDark, 'dark');
  }

  if (baseHue === -2) {
    // Light Gray theme (lighter than before)
    return generateNeutralTheme(isDark, 'light');
  }

  if (baseHue === -3) {
    // Original theme - return empty object to use CSS defaults
    // This lets the original CSS :root and .dark selectors handle the theming
    return {};
  }

  if (isDark) {
    // Dark mode color generation
    return {
      // Backgrounds - very dark with subtle color
      background: `oklch(0.129 0.042 ${baseHue})`,
      card: `oklch(0.208 0.042 ${(baseHue + 5) % 360})`,
      popover: `oklch(0.208 0.042 ${(baseHue + 5) % 360})`,

      // Interactive elements
      primary: `oklch(0.929 0.013 ${(baseHue - 5) % 360})`,
      secondary: `oklch(0.279 0.041 ${baseHue})`,
      accent: `oklch(0.279 0.041 ${(baseHue + 10) % 360})`,
      muted: `oklch(0.279 0.041 ${baseHue})`,

      // Destructive (use red-orange regardless of base)
      destructive: `oklch(0.704 0.191 22.216)`,

      // Borders and inputs - keep some color but subtle
      border: `oklch(1 0 0 / 10%)`,
      input: `oklch(1 0 0 / 15%)`,
      ring: `oklch(0.551 0.027 ${(baseHue + 4) % 360})`,

      // Text colors
      foreground: `oklch(0.984 0.003 ${(baseHue - 15) % 360})`,
      'card-foreground': `oklch(0.984 0.003 ${(baseHue - 15) % 360})`,
      'popover-foreground': `oklch(0.984 0.003 ${(baseHue - 15) % 360})`,
      'primary-foreground': `oklch(0.208 0.042 ${(baseHue + 5) % 360})`,
      'secondary-foreground': `oklch(0.984 0.003 ${(baseHue - 15) % 360})`,
      'accent-foreground': `oklch(0.984 0.003 ${(baseHue - 15) % 360})`,
      'muted-foreground': `oklch(0.704 0.04 ${(baseHue - 4) % 360})`,

      // Chart colors - spread across color wheel for contrast
      'chart-1': `oklch(0.488 0.243 ${baseHue})`,
      'chart-2': `oklch(0.696 0.17 ${(baseHue + 120) % 360})`,
      'chart-3': `oklch(0.769 0.188 ${(baseHue + 240) % 360})`,
      'chart-4': `oklch(0.627 0.265 ${(baseHue + 60) % 360})`,
      'chart-5': `oklch(0.645 0.246 ${(baseHue + 300) % 360})`,

      // Sidebar colors
      sidebar: `oklch(0.208 0.042 ${(baseHue + 5) % 360})`,
      'sidebar-foreground': `oklch(0.984 0.003 ${(baseHue - 15) % 360})`,
      'sidebar-primary': `oklch(0.488 0.243 ${baseHue})`,
      'sidebar-primary-foreground': `oklch(0.984 0.003 ${(baseHue - 15) % 360})`,
      'sidebar-accent': `oklch(0.279 0.041 ${baseHue})`,
      'sidebar-accent-foreground': `oklch(0.984 0.003 ${(baseHue - 15) % 360})`,
      'sidebar-border': `oklch(1 0 0 / 10%)`,
      'sidebar-ring': `oklch(0.551 0.027 ${(baseHue + 4) % 360})`,
    };
  } else {
    // Light mode color generation
    return {
      // Backgrounds - very light with subtle color
      background: `oklch(0.98 0.005 ${baseHue})`,
      card: `oklch(0.95 0.008 ${(baseHue + 5) % 360})`,
      popover: `oklch(0.95 0.008 ${(baseHue + 5) % 360})`,

      // Interactive elements
      primary: `oklch(0.35 0.12 ${baseHue})`,
      secondary: `oklch(0.85 0.02 ${(baseHue + 5) % 360})`,
      accent: `oklch(0.85 0.02 ${(baseHue + 10) % 360})`,
      muted: `oklch(0.85 0.02 ${(baseHue + 5) % 360})`,

      // Destructive
      destructive: `oklch(0.577 0.245 27.325)`,

      // Borders and inputs
      border: `oklch(0.9 0.01 ${(baseHue + 5) % 360})`,
      input: `oklch(0.9 0.01 ${(baseHue + 5) % 360})`,
      ring: `oklch(0.45 0.08 ${(baseHue + 4) % 360})`,

      // Text colors
      foreground: `oklch(0.15 0.02 ${(baseHue + 10) % 360})`,
      'card-foreground': `oklch(0.15 0.02 ${(baseHue + 10) % 360})`,
      'popover-foreground': `oklch(0.15 0.02 ${(baseHue + 10) % 360})`,
      'primary-foreground': `oklch(0.98 0.005 ${(baseHue - 5) % 360})`,
      'secondary-foreground': `oklch(0.35 0.08 ${baseHue})`,
      'accent-foreground': `oklch(0.35 0.08 ${baseHue})`,
      'muted-foreground': `oklch(0.5 0.04 ${(baseHue + 4) % 360})`,

      // Chart colors - vibrant but lighter
      'chart-1': `oklch(0.55 0.18 ${baseHue})`,
      'chart-2': `oklch(0.6 0.15 ${(baseHue + 120) % 360})`,
      'chart-3': `oklch(0.65 0.14 ${(baseHue + 240) % 360})`,
      'chart-4': `oklch(0.5 0.2 ${(baseHue + 60) % 360})`,
      'chart-5': `oklch(0.58 0.17 ${(baseHue + 300) % 360})`,

      // Sidebar colors
      sidebar: `oklch(0.95 0.008 ${(baseHue + 5) % 360})`,
      'sidebar-foreground': `oklch(0.15 0.02 ${(baseHue + 10) % 360})`,
      'sidebar-primary': `oklch(0.35 0.12 ${baseHue})`,
      'sidebar-primary-foreground': `oklch(0.98 0.005 ${(baseHue - 5) % 360})`,
      'sidebar-accent': `oklch(0.85 0.02 ${(baseHue + 10) % 360})`,
      'sidebar-accent-foreground': `oklch(0.35 0.08 ${baseHue})`,
      'sidebar-border': `oklch(0.9 0.01 ${(baseHue + 5) % 360})`,
      'sidebar-ring': `oklch(0.45 0.08 ${(baseHue + 4) % 360})`,
    };
  }
}

// Generate neutral theme colors (grays)
function generateNeutralTheme(isDark: boolean, variant: 'dark' | 'light'): Record<string, string> {
  if (isDark) {
    if (variant === 'dark') {
      // Dark neutral theme - lighter grays than before
      return {
        background: 'oklch(0.12 0 0)', // Lighter than 0.08
        card: 'oklch(0.16 0 0)', // Lighter than 0.12
        popover: 'oklch(0.16 0 0)',
        primary: 'oklch(0.88 0 0)', // Slightly darker than 0.9
        secondary: 'oklch(0.22 0 0)', // Lighter than 0.18
        accent: 'oklch(0.22 0 0)',
        muted: 'oklch(0.22 0 0)',
        destructive: 'oklch(0.704 0.191 22.216)',
        border: 'oklch(0.24 0 0)', // Lighter than 0.2
        input: 'oklch(0.24 0 0)',
        ring: 'oklch(0.5 0 0)',
        foreground: 'oklch(0.96 0 0)', // Slightly darker than 0.98
        'card-foreground': 'oklch(0.96 0 0)',
        'popover-foreground': 'oklch(0.96 0 0)',
        'primary-foreground': 'oklch(0.12 0 0)',
        'secondary-foreground': 'oklch(0.96 0 0)',
        'accent-foreground': 'oklch(0.96 0 0)',
        'muted-foreground': 'oklch(0.6 0 0)',
        'chart-1': 'oklch(0.4 0 0)',
        'chart-2': 'oklch(0.5 0 0)',
        'chart-3': 'oklch(0.6 0 0)',
        'chart-4': 'oklch(0.7 0 0)',
        'chart-5': 'oklch(0.8 0 0)',
        sidebar: 'oklch(0.16 0 0)',
        'sidebar-foreground': 'oklch(0.96 0 0)',
        'sidebar-primary': 'oklch(0.4 0 0)',
        'sidebar-primary-foreground': 'oklch(0.96 0 0)',
        'sidebar-accent': 'oklch(0.22 0 0)',
        'sidebar-accent-foreground': 'oklch(0.96 0 0)',
        'sidebar-border': 'oklch(0.24 0 0)',
        'sidebar-ring': 'oklch(0.5 0 0)',
      };
    } else {
      // Light neutral theme in dark mode - much lighter warm grays
      return {
        background: 'oklch(0.18 0.003 60)', // Lighter than 0.15
        card: 'oklch(0.23 0.005 60)', // Lighter than 0.2
        popover: 'oklch(0.23 0.005 60)',
        primary: 'oklch(0.82 0.008 60)', // Lighter than 0.85
        secondary: 'oklch(0.28 0.008 60)', // Lighter than 0.25
        accent: 'oklch(0.28 0.008 60)',
        muted: 'oklch(0.28 0.008 60)',
        destructive: 'oklch(0.704 0.191 22.216)',
        border: 'oklch(0.33 0.005 60)', // Lighter than 0.3
        input: 'oklch(0.33 0.005 60)',
        ring: 'oklch(0.5 0.012 60)',
        foreground: 'oklch(0.92 0.005 60)', // Lighter than 0.95
        'card-foreground': 'oklch(0.92 0.005 60)',
        'popover-foreground': 'oklch(0.92 0.005 60)',
        'primary-foreground': 'oklch(0.18 0.003 60)',
        'secondary-foreground': 'oklch(0.92 0.005 60)',
        'accent-foreground': 'oklch(0.92 0.005 60)',
        'muted-foreground': 'oklch(0.68 0.008 60)', // Lighter than 0.65
        'chart-1': 'oklch(0.4 0.015 60)',
        'chart-2': 'oklch(0.5 0.015 60)',
        'chart-3': 'oklch(0.6 0.015 60)',
        'chart-4': 'oklch(0.7 0.015 60)',
        'chart-5': 'oklch(0.8 0.015 60)',
        sidebar: 'oklch(0.23 0.005 60)',
        'sidebar-foreground': 'oklch(0.92 0.005 60)',
        'sidebar-primary': 'oklch(0.4 0.015 60)',
        'sidebar-primary-foreground': 'oklch(0.92 0.005 60)',
        'sidebar-accent': 'oklch(0.28 0.008 60)',
        'sidebar-accent-foreground': 'oklch(0.92 0.005 60)',
        'sidebar-border': 'oklch(0.33 0.005 60)',
        'sidebar-ring': 'oklch(0.5 0.012 60)',
      };
    }
  } else {
    // Light mode neutral themes
    if (variant === 'dark') {
      // Dark neutral in light mode - cool grays
      return {
        background: 'oklch(0.98 0.002 240)',
        card: 'oklch(0.96 0.003 240)',
        popover: 'oklch(0.96 0.003 240)',
        primary: 'oklch(0.25 0.01 240)',
        secondary: 'oklch(0.92 0.005 240)',
        accent: 'oklch(0.92 0.005 240)',
        muted: 'oklch(0.92 0.005 240)',
        destructive: 'oklch(0.577 0.245 27.325)',
        border: 'oklch(0.88 0.005 240)',
        input: 'oklch(0.88 0.005 240)',
        ring: 'oklch(0.45 0.02 240)',
        foreground: 'oklch(0.15 0.008 240)',
        'card-foreground': 'oklch(0.15 0.008 240)',
        'popover-foreground': 'oklch(0.15 0.008 240)',
        'primary-foreground': 'oklch(0.98 0.002 240)',
        'secondary-foreground': 'oklch(0.25 0.01 240)',
        'accent-foreground': 'oklch(0.25 0.01 240)',
        'muted-foreground': 'oklch(0.45 0.01 240)',
        'chart-1': 'oklch(0.3 0.02 240)',
        'chart-2': 'oklch(0.4 0.02 240)',
        'chart-3': 'oklch(0.5 0.02 240)',
        'chart-4': 'oklch(0.6 0.02 240)',
        'chart-5': 'oklch(0.7 0.02 240)',
        sidebar: 'oklch(0.96 0.003 240)',
        'sidebar-foreground': 'oklch(0.15 0.008 240)',
        'sidebar-primary': 'oklch(0.25 0.01 240)',
        'sidebar-primary-foreground': 'oklch(0.98 0.002 240)',
        'sidebar-accent': 'oklch(0.92 0.005 240)',
        'sidebar-accent-foreground': 'oklch(0.25 0.01 240)',
        'sidebar-border': 'oklch(0.88 0.005 240)',
        'sidebar-ring': 'oklch(0.45 0.02 240)',
      };
    } else {
      // Light neutral in light mode - very light warm whites
      return {
        background: 'oklch(0.995 0.001 60)', // Even lighter than 0.99
        card: 'oklch(0.985 0.002 60)', // Lighter than 0.97
        popover: 'oklch(0.985 0.002 60)',
        primary: 'oklch(0.32 0.015 60)', // Slightly darker than 0.3
        secondary: 'oklch(0.96 0.003 60)', // Lighter than 0.94
        accent: 'oklch(0.96 0.003 60)',
        muted: 'oklch(0.96 0.003 60)',
        destructive: 'oklch(0.577 0.245 27.325)',
        border: 'oklch(0.92 0.003 60)', // Lighter than 0.9
        input: 'oklch(0.92 0.003 60)',
        ring: 'oklch(0.5 0.015 60)',
        foreground: 'oklch(0.22 0.005 60)', // Slightly lighter than 0.2
        'card-foreground': 'oklch(0.22 0.005 60)',
        'popover-foreground': 'oklch(0.22 0.005 60)',
        'primary-foreground': 'oklch(0.995 0.001 60)',
        'secondary-foreground': 'oklch(0.32 0.015 60)',
        'accent-foreground': 'oklch(0.32 0.015 60)',
        'muted-foreground': 'oklch(0.52 0.008 60)', // Lighter than 0.5
        'chart-1': 'oklch(0.35 0.02 60)',
        'chart-2': 'oklch(0.45 0.02 60)',
        'chart-3': 'oklch(0.55 0.02 60)',
        'chart-4': 'oklch(0.65 0.02 60)',
        'chart-5': 'oklch(0.75 0.02 60)',
        sidebar: 'oklch(0.985 0.002 60)',
        'sidebar-foreground': 'oklch(0.22 0.005 60)',
        'sidebar-primary': 'oklch(0.32 0.015 60)',
        'sidebar-primary-foreground': 'oklch(0.995 0.001 60)',
        'sidebar-accent': 'oklch(0.96 0.003 60)',
        'sidebar-accent-foreground': 'oklch(0.32 0.015 60)',
        'sidebar-border': 'oklch(0.92 0.003 60)',
        'sidebar-ring': 'oklch(0.5 0.015 60)',
      };
    }
  }
}

const initialState: ThemeProviderState = {
  themeState: {
    mode: 'system',
    colorTheme: PRESET_THEMES[0],
    colorOverrides: {},
  },
  setTheme: () => null,
  setColorTheme: () => null,
  exportTheme: () => ({
    version: 1,
    name: '',
    colorTheme: PRESET_THEMES[0],
    colorOverrides: {},
    exportedAt: '',
  }),
  importTheme: () => false,
  setCustomColor: () => null,
  setColorVariable: () => null,
  clearColorVariable: () => null,
  clearAllColorOverrides: () => null,
  getEffectiveColor: () => undefined,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  defaultColorTheme = PRESET_THEMES[0],
  storageKey = 'vite-ui-theme',
  colorStorageKey = 'ci-ui-color-theme',
  colorOverridesStorageKey = 'ci-ui-color-overrides',
}: ThemeProviderProps) {
  const [themeState, setThemeState] = useState<ThemeState>(() => {
    // Try to get theme from localStorage first
    const storedTheme = localStorage.getItem(storageKey) as Theme;
    const storedColorTheme = localStorage.getItem(colorStorageKey);
    const storedColorOverrides = localStorage.getItem(colorOverridesStorageKey);

    let colorTheme = defaultColorTheme;
    if (storedColorTheme) {
      try {
        colorTheme = JSON.parse(storedColorTheme);
      } catch {
        // Fallback to default if parsing fails
      }
    }

    let colorOverrides: ColorOverrides = {};
    if (storedColorOverrides) {
      try {
        colorOverrides = JSON.parse(storedColorOverrides);
      } catch {
        // Fallback to empty overrides if parsing fails
      }
    }

    return {
      mode: storedTheme || defaultTheme,
      colorTheme,
      colorOverrides,
    };
  });

  // Helper to get effective color (override or generated)
  const getEffectiveColor = (variable: ThemeColorVariable): string | undefined => {
    // Check for override first
    if (themeState.colorOverrides[variable]) {
      return themeState.colorOverrides[variable];
    }

    // Otherwise get the generated color
    let effectiveMode = themeState.mode;
    if (themeState.mode === 'system') {
      effectiveMode =
        typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
    }

    const isDark = effectiveMode === 'dark';
    const colors = generateThemeColors(themeState.colorTheme.baseHue, isDark);

    return colors[variable];
  };

  useEffect(() => {
    const root = window.document.documentElement;

    // Remove any existing theme classes
    root.classList.remove('light', 'dark');

    let effectiveMode = themeState.mode;
    if (themeState.mode === 'system') {
      effectiveMode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    root.classList.add(effectiveMode);

    if (themeState.colorTheme.baseHue === -3) {
      // Original theme - remove all custom properties to use CSS defaults
      // This allows the original :root and .dark CSS rules to take effect
      THEME_COLOR_VARIABLES.forEach((key) => {
        // But still apply any overrides
        const override = themeState.colorOverrides[key];
        if (override) {
          root.style.setProperty(`--${key}`, override);
        } else {
          root.style.removeProperty(`--${key}`);
        }
      });
    } else {
      // Apply custom color theme for both light and dark modes
      const isDark = effectiveMode === 'dark';
      const colors = generateThemeColors(themeState.colorTheme.baseHue, isDark);

      // Apply generated colors, but overrides take precedence
      Object.entries(colors).forEach(([key, value]) => {
        const override = themeState.colorOverrides[key as ThemeColorVariable];
        root.style.setProperty(`--${key}`, override ?? value);
      });
    }
  }, [themeState]);

  const setTheme = (theme: Theme) => {
    localStorage.setItem(storageKey, theme);
    setThemeState((prev) => ({ ...prev, mode: theme }));
  };

  const setColorTheme = (colorTheme: ColorTheme) => {
    localStorage.setItem(colorStorageKey, JSON.stringify(colorTheme));
    setThemeState((prev) => ({ ...prev, colorTheme }));
  };

  const setCustomColor = (hue: number) => {
    const customTheme: ColorTheme = {
      name: `Custom ${hue}°`,
      baseHue: hue,
      isCustom: true,
    };
    setColorTheme(customTheme);
  };

  const setColorVariable = (variable: ThemeColorVariable, color: string) => {
    const newOverrides = { ...themeState.colorOverrides, [variable]: color };
    localStorage.setItem(colorOverridesStorageKey, JSON.stringify(newOverrides));
    setThemeState((prev) => ({ ...prev, colorOverrides: newOverrides }));
  };

  const clearColorVariable = (variable: ThemeColorVariable) => {
    const newOverrides = { ...themeState.colorOverrides };
    delete newOverrides[variable];
    localStorage.setItem(colorOverridesStorageKey, JSON.stringify(newOverrides));
    setThemeState((prev) => ({ ...prev, colorOverrides: newOverrides }));
  };

  const clearAllColorOverrides = () => {
    localStorage.removeItem(colorOverridesStorageKey);
    setThemeState((prev) => ({ ...prev, colorOverrides: {} }));
  };

  const exportTheme = (name?: string): ShareableTheme => {
    const themeName = name || themeState.colorTheme.name || `Custom Theme ${new Date().toLocaleDateString()}`;

    // Capture the effective value of ALL variables (not just overrides)
    const allColors: ColorOverrides = {};
    for (const variable of THEME_COLOR_VARIABLES) {
      const color = getEffectiveColor(variable);
      if (color) {
        allColors[variable] = color;
      }
    }

    return {
      version: 1,
      name: themeName,
      colorTheme: themeState.colorTheme,
      colorOverrides: allColors,
      exportedAt: new Date().toISOString(),
    };
  };

  const importTheme = (theme: ShareableTheme): boolean => {
    try {
      // Validate the theme structure
      if (theme.version !== 1 || !theme.colorTheme) {
        console.error('Invalid theme format');

        return false;
      }

      // Apply the color theme
      const importedColorTheme: ColorTheme = {
        name: theme.name || theme.colorTheme.name,
        baseHue: theme.colorTheme.baseHue,
        isCustom: theme.colorTheme.isCustom,
      };
      localStorage.setItem(colorStorageKey, JSON.stringify(importedColorTheme));

      // Apply the color overrides
      const importedOverrides = theme.colorOverrides || {};
      localStorage.setItem(colorOverridesStorageKey, JSON.stringify(importedOverrides));

      // Update state
      setThemeState((prev) => ({
        ...prev,
        colorTheme: importedColorTheme,
        colorOverrides: importedOverrides,
      }));

      return true;
    } catch (error) {
      console.error('Failed to import theme:', error);

      return false;
    }
  };

  const value = {
    themeState,
    setTheme,
    setColorTheme,
    exportTheme,
    importTheme,
    setCustomColor,
    setColorVariable,
    clearColorVariable,
    clearAllColorOverrides,
    getEffectiveColor,
  };

  return <ThemeProviderContext.Provider value={value}>{children}</ThemeProviderContext.Provider>;
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
};
