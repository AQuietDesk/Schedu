import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark" | "system";

const THEMES: readonly Theme[] = ["light", "dark", "system"];

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

// localStorage (not the SQLite `preference` table) so index.html's inline
// no-flash script can read it synchronously before React — and before any
// Tauri IPC round-trip — ever runs.
export const THEME_STORAGE_KEY = "life-os-theme";

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: THEME_STORAGE_KEY,
      version: 1,
      // v0 could persist "futuristic", which no longer exists — fall back to
      // following the OS instead of leaving the store holding a dead value.
      migrate: (persisted) => {
        const theme = (persisted as { theme?: string } | undefined)?.theme;
        return { theme: THEMES.includes(theme as Theme) ? (theme as Theme) : "system" } as ThemeState;
      },
    },
  ),
);
