import type { FocusSession } from "@/types";

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatFocusDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h === 0 && m === 0) return "< 1m";
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// `actual_duration_seconds` is the focus-only portion (break time excluded
// by construction — see complete_focus_phase in src-tauri/src/focus.rs).
function focusedSeconds(session: FocusSession): number {
  return session.actual_duration_seconds ?? 0;
}

export function sessionsToday(sessions: FocusSession[]): FocusSession[] {
  const today = dateKey(new Date());
  return sessions.filter((s) => dateKey(new Date(s.started_at)) === today);
}

export function todayFocusedSeconds(sessions: FocusSession[]): number {
  return sessionsToday(sessions).reduce((sum, s) => sum + focusedSeconds(s), 0);
}

function sinceCutoff(sessions: FocusSession[], days: number): FocusSession[] {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return sessions.filter((s) => new Date(s.started_at) >= cutoff);
}

export function weekFocusedSeconds(sessions: FocusSession[]): number {
  return sinceCutoff(sessions, 7).reduce((sum, s) => sum + focusedSeconds(s), 0);
}

export function monthFocusedSeconds(sessions: FocusSession[]): number {
  return sinceCutoff(sessions, 30).reduce((sum, s) => sum + focusedSeconds(s), 0);
}

export function focusedSecondsByCategory(sessions: FocusSession[]): Record<string, number> {
  const byCategory: Record<string, number> = {};
  for (const session of sessions) {
    const key = session.category ?? "Uncategorized";
    byCategory[key] = (byCategory[key] ?? 0) + focusedSeconds(session);
  }
  return byCategory;
}

export function recentSessions(sessions: FocusSession[], limit: number): FocusSession[] {
  return sessions.slice(0, limit);
}
