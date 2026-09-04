import { isIosPlatform } from '@ci/common';
import type { LucideIcon } from '@ci/shadcn/icons';
import {
  Bot,
  Compass,
  Cpu,
  Globe,
  HardDrive,
  Key,
  KeyRound,
  MapPin,
  MessageCircle,
  Palette,
  Plug,
  Shield,
} from '@ci/shadcn/icons';

export interface SettingsSection {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Bundled Safari Web Extension — only the iOS Memory app contains it. */
  readonly iosOnly?: boolean;
}

/**
 * Shared settings destinations — desktop dialog nav and the mobile Self
 * settings hub. `about-you` and `account` moved to the bottom of the Self
 * page's Profile tab (`/self`) and are deliberately absent here now — see
 * App.tsx for the redirects that keep old `/settings/about-you` and
 * `/settings/account` links working.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'preferences', label: 'Preferences', icon: Globe },
  { id: 'autonomy', label: 'Autonomy', icon: Shield },
  { id: 'model', label: 'Model', icon: Cpu },
  { id: 'location', label: 'Location', icon: MapPin },
  { id: 'safari', label: 'Safari', icon: Compass, iosOnly: true },
  { id: 'bluebubbles', label: 'BlueBubbles', icon: MessageCircle },
  { id: 'mcp', label: 'MCP Servers', icon: Plug },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'api-keys', label: 'API Keys', icon: KeyRound },
  { id: 'oauth', label: 'OAuth Credentials', icon: Key },
  { id: 'data', label: 'Your data', icon: HardDrive },
];

export function visibleSettingsSections(): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => !section.iosOnly || isIosPlatform());
}

export function settingsPathToProfile(pathname: string): string {
  const rest = pathname.replace(/^\/settings\/?/, '');

  return rest ? `/self/settings/${rest}` : '/self/settings';
}
