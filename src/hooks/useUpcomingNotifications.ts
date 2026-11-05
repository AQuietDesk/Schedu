import { useEffect, useMemo, useRef, useState } from "react";
import { usePreferences, useSetPreference } from "@/hooks/usePreferences";
import { daysUntil } from "@/lib/dates";
import {
  evaluateNotifications,
  notificationItemKind,
  UPCOMING_NOTIFICATION_DEFAULTS,
  urgencyForDays,
  type NotificationCandidate,
  type NotificationState,
  type NotificationWindowDays,
  type UpcomingNotificationSettings,
} from "@/lib/notificationEngine";
import type { Item } from "@/types";

export const UPCOMING_WINDOW_PREF_KEY = "upcoming_notification_window_days";
export const UPCOMING_PRIORITY_OVERRIDE_PREF_KEY = "upcoming_notification_priority_override_enabled";
export const UPCOMING_REPEAT_DAILY_PREF_KEY = "upcoming_notification_repeat_daily_enabled";
const UPCOMING_STATE_PREF_KEY = "upcoming_notification_state";

const VALID_WINDOW_DAYS: readonly NotificationWindowDays[] = [0, 1, 3, 5, 7];

function parseSettings(prefs: Record<string, string> | undefined): UpcomingNotificationSettings {
  const windowRaw = Number(prefs?.[UPCOMING_WINDOW_PREF_KEY]);
  const windowDays = VALID_WINDOW_DAYS.includes(windowRaw as NotificationWindowDays)
    ? (windowRaw as NotificationWindowDays)
    : UPCOMING_NOTIFICATION_DEFAULTS.windowDays;
  return {
    windowDays,
    priorityOverrideEnabled: prefs?.[UPCOMING_PRIORITY_OVERRIDE_PREF_KEY] !== "false",
    repeatDailyEnabled: prefs?.[UPCOMING_REPEAT_DAILY_PREF_KEY] !== "false",
  };
}

function parseState(raw: string | undefined): NotificationState {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as NotificationState;
  } catch {
    return {};
  }
}

/** Settings-page wiring for the three Upcoming Notifications preferences. */
export function useUpcomingNotificationSettings() {
  const { data: prefs } = usePreferences();
  const setPreference = useSetPreference();
  return {
    settings: parseSettings(prefs),
    setWindowDays: (days: NotificationWindowDays) =>
      setPreference.mutate({ key: UPCOMING_WINDOW_PREF_KEY, value: String(days) }),
    setPriorityOverrideEnabled: (enabled: boolean) =>
      setPreference.mutate({ key: UPCOMING_PRIORITY_OVERRIDE_PREF_KEY, value: String(enabled) }),
    setRepeatDailyEnabled: (enabled: boolean) =>
      setPreference.mutate({ key: UPCOMING_REPEAT_DAILY_PREF_KEY, value: String(enabled) }),
  };
}

/**
 * Drives the Dashboard's notification center. Evaluates candidates exactly
 * once per mount (the "app/dashboard opened" trigger), then persists that
 * evaluation's `nextState` so a reopened app — or a same-day revisit of the
 * Dashboard — doesn't re-surface what's already been shown today. The
 * candidate list itself is then held locally: re-running evaluateNotifications
 * on every prefs refetch would immediately see the state write this hook
 * just made and reclassify those same items as "already notified today",
 * emptying the center out from under the user seconds after it opened.
 *
 * Completion is the one thing still read live: on every render, each shown
 * candidate's underlying item is re-checked, so completing (or reopening)
 * an item while the center is open makes it disappear (or become eligible
 * again) immediately, per the existing item table's status as the sole
 * source of truth.
 */
export function useUpcomingNotifications(items: Item[], itemsReady: boolean) {
  const { data: prefs, isSuccess: prefsReady } = usePreferences();
  const setPreference = useSetPreference();

  const itemsRef = useRef(items);
  itemsRef.current = items;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const [shownIds, setShownIds] = useState<string[] | null>(null);
  const hasEvaluatedRef = useRef(false);

  useEffect(() => {
    if (hasEvaluatedRef.current || !itemsReady || !prefsReady) return;
    hasEvaluatedRef.current = true;

    const settings = parseSettings(prefsRef.current);
    const state = parseState(prefsRef.current?.[UPCOMING_STATE_PREF_KEY]);
    const { candidates, nextState } = evaluateNotifications(itemsRef.current, state, settings, new Date());
    setShownIds(candidates.map((c) => c.item.id));
    if (candidates.length > 0) {
      setPreference.mutate({ key: UPCOMING_STATE_PREF_KEY, value: JSON.stringify(nextState) });
    }
    // Only ever runs once — the moment both items and prefs are first ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsReady, prefsReady]);

  const candidates: NotificationCandidate[] = useMemo(() => {
    if (!shownIds) return [];
    const byId = new Map(items.map((i) => [i.id, i]));
    const result: NotificationCandidate[] = [];
    for (const id of shownIds) {
      const item = byId.get(id);
      if (!item || item.due_date == null || item.status === "Completed") continue;
      const days = daysUntil(item.due_date);
      if (days === null) continue;
      result.push({ item, days, urgency: urgencyForDays(days), kind: notificationItemKind(item) });
    }
    return result;
  }, [shownIds, items]);

  const dismissOne = (id: string) => {
    setShownIds((prev) => prev?.filter((x) => x !== id) ?? null);
    patchDismissed(prefsRef.current, setPreference, [id]);
  };

  const dismissAll = () => {
    const ids = shownIds ?? [];
    setShownIds([]);
    patchDismissed(prefsRef.current, setPreference, ids);
  };

  return { candidates, dismissOne, dismissAll };
}

function patchDismissed(
  prefs: Record<string, string> | undefined,
  setPreference: ReturnType<typeof useSetPreference>,
  ids: string[],
): void {
  if (ids.length === 0) return;
  const state = parseState(prefs?.[UPCOMING_STATE_PREF_KEY]);
  const now = new Date().toISOString();
  const next: NotificationState = { ...state };
  for (const id of ids) {
    const existing = next[id];
    if (existing) next[id] = { ...existing, dismissedAt: now };
  }
  setPreference.mutate({ key: UPCOMING_STATE_PREF_KEY, value: JSON.stringify(next) });
}
