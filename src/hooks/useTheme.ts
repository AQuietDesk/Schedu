import { useEffect } from "react";
import { type Theme, useThemeStore } from "@/store/themeStore";

function resolveIsDark(theme: Theme): boolean {
  if (theme === "dark") return true;
  return theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/// Mounted once near the app root. Keeps `<html>`'s `dark` class (which
/// index.html's inline script already set once, synchronously, to avoid a
/// flash on load) in sync with the store — both when the user picks a theme
/// and, for "system", when the OS-level preference changes underneath it.
export function useThemeEffect() {
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolveIsDark(theme));
    root.classList.remove("futuristic");
    if (theme !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => root.classList.toggle("dark", resolveIsDark(theme));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);
}

export function useTheme() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  return { theme, setTheme };
}
