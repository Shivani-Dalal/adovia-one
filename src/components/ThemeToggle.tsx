import { useEffect, useState } from 'react';
import { applyTheme, storedTheme, type Theme } from '../lib/theme';

/**
 * The light/dark switch.
 *
 * Labelled with the theme you are switching *to*, not the one you are in. An
 * unlabelled moon is ambiguous — half of people read it as "you are in dark
 * mode", the other half as "click for dark mode" — and the fix costs one word.
 * The word hides under 720px; the icon and the accessible name do not.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(storedTheme);

  /*
    The inline script in index.html sets the attribute for the first paint;
    this owns it from then on. Running on mount as well as on change is
    deliberate — it costs one no-op write and means the app is still correct if
    that script was ever blocked or dropped.
  */
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  const label = next === 'dark' ? 'Dark' : 'Light';

  return (
    <button
      type="button"
      className="btn ghost sm themetoggle"
      onClick={() => setTheme(next)}
      title={`Switch to the ${next} theme`}
      aria-label={`Switch to the ${next} theme`}
    >
      {next === 'dark' ? <Moon /> : <Sun />}
      <span className="tt-label">{label}</span>
    </button>
  );
}

/* Inline rather than an icon dependency: two glyphs, ~15 lines, and they
   inherit `currentColor` so they theme themselves along with the button. */

function Moon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Sun() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13" />
    </svg>
  );
}
