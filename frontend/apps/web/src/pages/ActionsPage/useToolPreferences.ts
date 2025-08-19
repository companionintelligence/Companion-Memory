import { useState, useEffect } from 'react';

export interface ToolPreferences {
  [toolId: string]: boolean;
}

const STORAGE_KEY = 'companion-intel-tool-preferences';

const DEFAULT_PREFERENCES: ToolPreferences = {
  'food-preferences': true,
  'entertainment-preferences': true,
  'streaming-availability': true,
  'family-members': false, // Disabled by default (matches backend)
};

export function useToolPreferences() {
  const [preferences, setPreferences] = useState<ToolPreferences>(DEFAULT_PREFERENCES);
  const [isLoading, setIsLoading] = useState(true);

  // Load preferences from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Merge with defaults to handle new tools
        setPreferences({ ...DEFAULT_PREFERENCES, ...parsed });
      }
    } catch (error) {
      console.warn('Failed to load tool preferences from localStorage:', error);
      // Keep default preferences
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Save preferences to localStorage whenever they change
  useEffect(() => {
    if (!isLoading) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
      } catch (error) {
        console.warn('Failed to save tool preferences to localStorage:', error);
      }
    }
  }, [preferences, isLoading]);

  const toggleTool = (toolId: string) => {
    setPreferences((prev) => ({
      ...prev,
      [toolId]: !prev[toolId],
    }));
  };

  const isToolEnabled = (toolId: string): boolean => {
    return preferences[toolId] ?? false;
  };

  const getEnabledToolsCount = (): number => {
    return Object.values(preferences).filter(Boolean).length;
  };

  const getDisabledToolsCount = (): number => {
    return Object.values(preferences).filter((enabled) => !enabled).length;
  };

  return {
    preferences,
    toggleTool,
    isToolEnabled,
    getEnabledToolsCount,
    getDisabledToolsCount,
    isLoading,
  };
}
