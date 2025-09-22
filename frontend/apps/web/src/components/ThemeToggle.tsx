import { Button } from '@ci/shadcn';
import { Monitor, Moon, Sun } from '@ci/shadcn/icons';

import { useTheme } from '@/hooks/use-theme';

export function ThemeToggle() {
  const { themeState, setTheme } = useTheme();

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
        return <Sun className="h-5 w-5" />;
      case 'dark':
        return <Moon className="h-5 w-5" />;
      case 'system':
        return <Monitor className="h-5 w-5" />;
      default:
        return <Sun className="h-5 w-5" />;
    }
  };

  const getTooltipText = () => {
    switch (themeState.mode) {
      case 'light':
        return 'Switch to dark mode';
      case 'dark':
        return 'Switch to system mode';
      case 'system':
        return 'Switch to light mode';
      default:
        return 'Toggle theme';
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleToggle}
      title={getTooltipText()}
      aria-label={getTooltipText()}
    >
      {getIcon()}
    </Button>
  );
}
