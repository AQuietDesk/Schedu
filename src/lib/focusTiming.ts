import type { FocusSession } from "@/types";

// Elapsed/remaining time is always derived from `running_since` +
// `accumulated_seconds` at read time (never a decremented counter) — see the
// comment on the focus_session table in src-tauri/src/db.rs. This keeps the
// frontend, the backend, pause/resume, and an app-restart rehydrate all
// agreeing on the same number without any risk of tick drift.
export function elapsedSeconds(session: FocusSession, now: Date): number {
  if (!session.running_since) return session.accumulated_seconds;
  const runningMs = now.getTime() - new Date(session.running_since).getTime();
  return session.accumulated_seconds + Math.max(0, Math.floor(runningMs / 1000));
}

// null = no countdown to show (Open Focus, which counts up indefinitely).
export function remainingSeconds(session: FocusSession, now: Date): number | null {
  const elapsed = elapsedSeconds(session, now);
  if (session.phase === "break") {
    return Math.max(0, session.break_duration_seconds - elapsed);
  }
  if (session.planned_duration_seconds === null) return null;
  return Math.max(0, session.planned_duration_seconds - elapsed);
}

export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
