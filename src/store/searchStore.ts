import { create } from "zustand";

interface SearchState {
  isOpen: boolean;
  /** Text the command bar opens with (e.g. a quick-add started elsewhere). */
  initialQuery: string;
  open: (initialQuery?: string) => void;
  close: () => void;
  toggle: () => void;
}

/** Drives the single Ctrl K command bar — search, quick add and "go to". */
export const useSearchStore = create<SearchState>()((set) => ({
  isOpen: false,
  initialQuery: "",
  open: (initialQuery = "") => set({ isOpen: true, initialQuery }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen, initialQuery: "" })),
}));
