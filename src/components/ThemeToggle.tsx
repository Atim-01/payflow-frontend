"use client";

import { useI18n } from "@/i18n/provider";

import { useEffect, useState } from "react";
import {
  applyTheme,
  saveTheme,
  storedTheme,
  type ThemePreference,
} from "@/lib/theme";

const NEXT: Record<ThemePreference, ThemePreference> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const LABEL: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

/**
 * Cycles System → Light → Dark.
 *
 * A single compact button keeps the header usable at 375px. The accessible
 * name states the current choice and what activating it will do, so the
 * control is understandable without seeing the icon.
 */
export function ThemeToggle() {
  const { t: tr } = useI18n();
  // The static export is prerendered without localStorage. Start on the same
  // value the server rendered, then adopt the saved choice after mount; the
  // inline script has already painted the right colours by then.
  const [theme, setTheme] = useState<ThemePreference>("system");

  useEffect(() => {
    try { setTheme(storedTheme(window.localStorage)); } catch { /* Storage is optional. */ }
  }, []);

  function choose(next: ThemePreference) {
    setTheme(next);
    applyTheme(next);
    try { saveTheme(window.localStorage, next); } catch { /* In-memory theme still works. */ }
  }

  const next = NEXT[theme];

  return (
    <button
      type="button"
      onClick={() => choose(next)}
      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-edge text-muted transition hover:border-muted hover:bg-fg/5 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      aria-label={tr("Colour theme: {0}. Switch to {1}.", { "0": tr(LABEL[theme]), "1": tr(LABEL[next]) })}
      title={tr("Colour theme: {0} — switch to {1}", { "0": tr(LABEL[theme]), "1": tr(LABEL[next]) })}
    >
      {theme === "light" ? (
        <SunIcon />
      ) : theme === "dark" ? (
        <MoonIcon />
      ) : (
        <SystemIcon />
      )}
    </button>
  );
}
