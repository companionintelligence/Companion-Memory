import { IconButton } from '@ci/shadcn';
import { Monitor, Moon, Sun } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { useTheme } from './useTheme';

export function ThemeToggle() {
  const { themeState, setTheme } = useTheme();
  const { t } = useTranslation();

  const handleToggle = () => {
    if (themeState.mode === 'light') {
      setTheme('dark');
    } else if (themeState.mode === 'dark') {
      setTheme('system');
    } else {
      setTheme('light');
    }
  };

  const getIcon = () => {
    switch (themeState.mode) {
      case 'light':
        return <Sun className="h-4 w-4" />;
      case 'dark':
        return <Moon className="h-4 w-4" />;
      case 'system':
        return <Monitor className="h-4 w-4" />;
      default:
        return <Sun className="h-4 w-4" />;
    }
  };

  const getTooltipText = () => {
    switch (themeState.mode) {
      case 'light':
        return t('THEME_SWITCH_TO_DARK');
      case 'dark':
        return t('THEME_SWITCH_TO_SYSTEM');
      case 'system':
        return t('THEME_SWITCH_TO_LIGHT');
      default:
        return t('THEME_SWITCH_TO_LIGHT');
    }
  };

  return (
    <IconButton
      variant="ghost"
      onClick={handleToggle}
      label={getTooltipText()}
      className="max-device:size-11"
    >
      {getIcon()}
    </IconButton>
  );
}
