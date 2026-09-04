/**
 * Light or dark, remembered per browser.
 *
 * Light is the default and deliberately so, despite the marketing site being
 * dark: this is a working tool that people sit in front of for an hour at a
 * time entering figures, often in a lit office, and light is the safer default
 * for that. Dark is one click away and sticks.
 *
 * The OS `prefers-color-scheme` is NOT consulted. "Default to light" has to
 * mean light for everyone, or the first thing a Mac user on the dark system
 * setting sees is not the default at all, and two people comparing screens
 * disagree about what the app looks like.
 */

export type Theme = 'light' | 'dark';

export const DEFAULT_THEME: Theme = 'light';

/**
 * Shared with the pre-paint script in index.html. That script is a duplicate
 * of `apply` in four lines of inline JS, and it has to be: a module can't run
 * before first paint, so without it a dark user gets a white flash on every
 * cold load. If this key changes, change it there too.
 */
const KEY = 'adovia-theme';

function isTheme(v: unknown): v is Theme {
  return v === 'light' || v === 'dark';
}

/**
 * Storage can throw — Safari in private mode, or a browser with cookies and
 * site data blocked. A theme preference is not worth a blank page, so every
 * access here fails soft and the app falls back to the default.
 */
export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Writes the attribute the stylesheet keys off, and mirrors it into storage.
 *
 * Light clears the attribute rather than setting `data-theme="light"`, because
 * light lives in `:root` — an explicit attribute would work, but it would make
 * `:root` and `[data-theme='light']` two ways of saying the same thing and
 * invite them to drift apart.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;

  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Preference won't survive a reload. The page is still correct right now.
  }
}
