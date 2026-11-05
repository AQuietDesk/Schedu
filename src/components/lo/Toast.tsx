import { useEffect } from "react";
import { create } from "zustand";

interface ToastState {
  message: string | null;
  action: { label: string; run: () => void } | null;
  id: number;
  show: (message: string, action?: { label: string; run: () => void }) => void;
  hide: () => void;
}

export const useToast = create<ToastState>()((set) => ({
  message: null,
  action: null,
  id: 0,
  show: (message, action) => set((s) => ({ message, action: action ?? null, id: s.id + 1 })),
  hide: () => set({ message: null, action: null }),
}));

/** One small confirmation at a time, bottom-center, gone after a few seconds. */
export function Toaster() {
  const { message, action, id, hide } = useToast();

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(hide, 3500);
    return () => clearTimeout(t);
  }, [message, id, hide]);

  if (!message) return null;
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-4 rounded-xl bg-foreground px-4 py-2.5 text-sm text-background shadow-pop [animation:lo-pop-in_140ms_ease-out]">
        <span>{message}</span>
        {action && (
          <button
            type="button"
            className="font-medium underline-offset-2 hover:underline"
            onClick={() => {
              action.run();
              hide();
            }}
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}
