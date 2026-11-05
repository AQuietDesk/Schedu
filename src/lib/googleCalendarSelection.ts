// Shared between Settings.tsx (the picker UI) and Calendar.tsx (what actually
// gets queried) so the two never drift on how the preference is encoded.
export const SELECTED_CALENDARS_PREF_KEY = "google_selected_calendar_ids";

interface CalendarRef {
  id: string;
  primary?: boolean | null;
}

// Primary plus the user's selected calendars, minus any selected id that is no
// longer in their CalendarList — a deleted or unshared calendar 404s on every
// events request, so querying it only surfaces a permanent error banner.
export function resolveCalendarIdsToQuery(
  connected: boolean,
  calendars: readonly CalendarRef[] | undefined,
  selectedIds: readonly string[],
): string[] {
  if (!connected) return [];
  if (!calendars || calendars.length === 0) return ["primary"];
  const known = new Set(calendars.map((c) => c.id));
  const ids = new Set<string>([calendars.find((c) => c.primary)?.id ?? "primary"]);
  for (const id of selectedIds) if (known.has(id)) ids.add(id);
  return Array.from(ids);
}

export function parseSelectedCalendarIds(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
