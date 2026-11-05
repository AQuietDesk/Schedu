import { create } from "zustand";
import { commands } from "@/lib/commands";
import { formatFocusDuration } from "@/lib/focusStatistics";
import { remainingSeconds } from "@/lib/focusTiming";
import type { FocusOutcome, FocusSession, StartFocusSessionInput } from "@/types";

interface FocusStoreState {
  session: FocusSession | null;
  tick: number;
  // Bumped whenever a session closes (endBreak/abandon) — useFocusSessions
  // includes this in its query key so the history list/progress stats pick
  // up the newly-closed session without a manual invalidate/refetch wiring.
  closedVersion: number;
  hydrate: () => Promise<void>;
  startSession: (input: StartFocusSessionInput) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  completePhase: () => Promise<void>;
  submitReflection: (outcome: FocusOutcome, note: string | null) => Promise<void>;
  endBreak: () => Promise<void>;
  abandon: () => Promise<void>;
}

// Lives outside React (module scope, like the pomodoroStore it replaces) so
// it keeps running regardless of which page is mounted. It never owns
// elapsed/remaining time itself (see lib/focusTiming.ts) — it only forces a
// once-a-second re-render and watches for a countdown reaching zero, so
// focus→break and break→done transitions fire even while nobody's looking.
let intervalId: ReturnType<typeof setInterval> | null = null;

function stopTicking() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function startTickingIfNeeded(session: FocusSession | null) {
  if (session === null || session.running_since === null) {
    stopTicking();
    return;
  }
  if (intervalId !== null) return;

  intervalId = setInterval(() => {
    const current = useFocusStore.getState().session;
    if (!current || !current.running_since) {
      stopTicking();
      return;
    }
    const remaining = remainingSeconds(current, new Date());
    if (remaining !== null && remaining <= 0) {
      stopTicking();
      if (current.phase === "focus") {
        void useFocusStore.getState().completePhase();
      } else {
        void useFocusStore.getState().endBreak();
      }
      return;
    }
    useFocusStore.setState((s) => ({ tick: s.tick + 1 }));
  }, 1000);
}

export const useFocusStore = create<FocusStoreState>((set, get) => ({
  session: null,
  tick: 0,
  closedVersion: 0,

  hydrate: async () => {
    const session = await commands.getActiveFocusSession();
    set({ session });
    startTickingIfNeeded(session);
  },

  startSession: async (input) => {
    const session = await commands.startFocusSession(input);
    set({ session });
    startTickingIfNeeded(session);
  },

  pause: async () => {
    const { session } = get();
    if (!session) return;
    const updated = await commands.pauseFocusSession(session.id);
    set({ session: updated });
    startTickingIfNeeded(updated);
  },

  resume: async () => {
    const { session } = get();
    if (!session) return;
    const updated = await commands.resumeFocusSession(session.id);
    set({ session: updated });
    startTickingIfNeeded(updated);
  },

  completePhase: async () => {
    const { session } = get();
    if (!session) return;
    const updated = await commands.completeFocusPhase(session.id);
    set({ session: updated });
    startTickingIfNeeded(updated);
    const duration = formatFocusDuration(updated.actual_duration_seconds ?? 0);
    commands
      .notifyNow("Focus complete", `${duration} on "${updated.intent}" — take a break.`)
      .catch(() => {});
  },

  submitReflection: async (outcome, note) => {
    const { session } = get();
    if (!session) return;
    const updated = await commands.submitReflection(session.id, outcome, note);
    set({ session: updated });
  },

  endBreak: async () => {
    const { session } = get();
    if (!session) return;
    await commands.endBreak(session.id);
    stopTicking();
    set((s) => ({ session: null, closedVersion: s.closedVersion + 1 }));
    commands.notifyNow("Break's over", "Ready to focus again?").catch(() => {});
  },

  abandon: async () => {
    const { session } = get();
    if (!session) return;
    await commands.abandonFocusSession(session.id);
    stopTicking();
    set((s) => ({ session: null, closedVersion: s.closedVersion + 1 }));
  },
}));
