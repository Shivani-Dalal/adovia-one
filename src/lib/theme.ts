/**
 * Light or dark, remembered per browser.
 *
 * Dark is the default, which puts the app on the same ground as the marketing
 * site: someone arriving from adovia.in shouldn't watch the brand change colour
 * on the way in. Light is one click away and sticks.
 *
 * Note the asymmetry this creates with the stylesheet, because it will look
 * wrong to anyone reading only one of the two files. `:root` in styles.css is
 * the LIGHT token set, and `[data-theme='dark']` overrides it — so the default
 * theme is the one that needs the attribute, and the attribute is absent only
 * when light has been chosen on purpose. `:root` is the base of the cascade,
 * not the default appearance. Those were the same thing until now.
 *
 * Leaving the CSS that way round was the smaller change: the alternative is
 * swapping which block holds which palette, which touches every token in a
 * stylesheet whose whole discipline is that the two blocks stay in step.
 *
 * The OS `prefers-color-scheme` is NOT consulted. "Default to dark" has to mean
 * dark for everyone, or the first thing someone on a light system setting sees
 * is not the default at all, and two people comparing screens disagree about
 * what the app looks like.
 */

export type Theme = 'light' | 'dark';

export const DEFAULT_THEME: Theme = 'dark';

/**
 * Shared with the pre-paint script in index.html. That script is a duplicate
 * of `apply` in a few lines of inline JS, and it has to be: a module can't run
 * before first paint, so without it a dark user gets a white flash on every
 * cold load. If this key changes, change it there too.
 *
 * Bumped from 'adovia-theme' when the default flipped to dark, and that bump is
 * load-bearing rather than tidiness. ThemeToggle applies the theme on mount, and
 * applying writes — so every browser that had ever opened the app was carrying
 * a stored 'light' that the OLD DEFAULT had written for it, not a choice anyone
 * made. Storage cannot tell those two apart: both are the string 'light'.
 * Without the bump, the new default would have reached only browsers that had
 * never loaded the app, which is nobody who would notice.
 *
 * The cost is that a genuine light preference from before the change is
 * forgotten once. That is the trade being made on purpose: one re-toggle for
 * the few who had chosen light, against a default that otherwise does not
 * arrive at all.
 */
const KEY = 'adovia-theme-2';

/** The pre-bump key. Cleared on write so the dead value doesn't linger. */
const OLD_KEY = 'adovia-theme';

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
 * invite them to drift apart. Since dark is the default, the cleared state is
 * now reached only by choosing light, never by arriving fresh.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;

  try {
    localStorage.setItem(KEY, theme);
    localStorage.removeItem(OLD_KEY);
  } catch {
    // Preference won't survive a reload. The page is still correct right now.
  }
}
