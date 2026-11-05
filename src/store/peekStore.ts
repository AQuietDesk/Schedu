import { create } from "zustand";

interface PeekState {
  itemId: string | null;
  open: (itemId: string) => void;
  close: () => void;
}

/**
 * The task side peek (Notion-style). One instance lives in AppLayout, so
 * clicking a task anywhere — Today, Tasks, a class page, search — opens the
 * same editor instead of each page carrying its own add/edit forms.
 */
export const usePeekStore = create<PeekState>()((set) => ({
  itemId: null,
  open: (itemId) => set({ itemId }),
  close: () => set({ itemId: null }),
}));
