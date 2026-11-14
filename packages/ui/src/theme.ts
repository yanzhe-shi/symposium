/** `system` follows the computer's light or dark setting. */
export type Theme = 'system' | 'light' | 'dark';

const THEME_KEY = 'symposium.theme';
const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

export const THEME_LABELS: Record<Theme, string> = {
  system: 'Match the system',
  light: 'Light',
  dark: 'Dark',
};

/** The theme after this one, for a button that cycles through them. */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
}

export function readTheme(stored: string | null): Theme {
  return THEMES.includes(stored as Theme) ? (stored as Theme) : 'system';
}

export function loadTheme(): Theme {
  return readTheme(localStorage.getItem(THEME_KEY));
}

/** Applies a theme to the page and remembers it. The stylesheet reads `data-theme`. */
export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}
