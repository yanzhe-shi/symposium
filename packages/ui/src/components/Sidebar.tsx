import type { Group } from '@symposium/engine/protocol';
import { useState } from 'react';
import { applyTheme, loadTheme, nextTheme, THEME_LABELS, type Theme } from '../theme.ts';
import { Avatar } from './Avatar.tsx';
import { notifyState, toggleNotify, type NotifyState } from '../notify.ts';
import {
  AutoThemeIcon,
  BellIcon,
  BellOffIcon,
  Logo,
  MoonIcon,
  PlusIcon,
  SunIcon,
} from './icons.tsx';

interface SidebarProps {
  groups: Group[];
  selectedId: string | undefined;
  onSelect: (groupId: string) => void;
  onNew: () => void;
}

const THEME_ICONS: Record<Theme, () => React.JSX.Element> = {
  system: AutoThemeIcon,
  light: SunIcon,
  dark: MoonIcon,
};

const NOTIFY_LABELS: Record<NotifyState, string> = {
  on: 'Notifications are on: you are told when a plan, a command or a hire waits for you, and when the team stops, while this page is in the background. Click to switch off.',
  off: 'Notifications are off. Click to be told when something waits for you while this page is in the background.',
  blocked:
    'Your browser blocks notifications for this page. Allow them in the site settings next to the address, then click here.',
  unsupported: '',
};

export function Sidebar({ groups, selectedId, onSelect, onNew }: SidebarProps) {
  const [theme, setTheme] = useState(loadTheme);
  const [notifying, setNotifying] = useState(notifyState);
  const NotifyIcon = notifying === 'on' ? BellIcon : BellOffIcon;
  const ThemeIcon = THEME_ICONS[theme];

  function cycleTheme(): void {
    const next = nextTheme(theme);
    applyTheme(next);
    setTheme(next);
  }

  return (
    <nav className="sidebar" aria-label="Groups">
      <div className="sidebar-brand">
        <Logo />
        <span>Symposium</span>
      </div>
      <div className="sidebar-heading">
        <span>Projects</span>
        <button
          type="button"
          className="icon-button"
          title="New group"
          aria-label="New group"
          onClick={onNew}
        >
          <PlusIcon />
        </button>
      </div>
      <ul className="group-list">
        {groups.map((group) => (
          <li key={group.id}>
            <button
              type="button"
              className={`group-link${group.id === selectedId ? ' group-link-selected' : ''}`}
              aria-current={group.id === selectedId ? 'page' : undefined}
              onClick={() => onSelect(group.id)}
              title={group.folderPath ?? undefined}
            >
              <Avatar name={group.name} variant="square" size="small" />
              <span className="group-link-name">{group.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="sidebar-footer">
        <button type="button" className="button-secondary sidebar-new" onClick={onNew}>
          <PlusIcon /> New group
        </button>
        {notifying !== 'unsupported' && (
          <button
            type="button"
            className="icon-button"
            title={NOTIFY_LABELS[notifying]}
            aria-label={NOTIFY_LABELS[notifying]}
            aria-pressed={notifying === 'on'}
            onClick={() => void toggleNotify().then(setNotifying)}
          >
            <NotifyIcon />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          title={`Theme: ${THEME_LABELS[theme]}. Click to change.`}
          aria-label={`Theme: ${THEME_LABELS[theme]}. Click to change.`}
          onClick={cycleTheme}
        >
          <ThemeIcon />
        </button>
      </div>
    </nav>
  );
}
