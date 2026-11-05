// Google Calendar's fixed per-event color palette (the "1".."11" ids
// returned as an event's `colorId`) — a small, effectively-static set that
// Google documents at https://developers.google.com/calendar/api/v3/reference/colors
// under `event`. Hardcoded rather than fetched from the `colors` endpoint at
// runtime: it hasn't changed in years, matches what Google Calendar's own
// event color picker shows, and avoids an extra API call/scope for a handful
// of hex values.
export const GOOGLE_EVENT_COLOR_HEX: Record<string, string> = {
  "1": "#7986cb", // Lavender
  "2": "#33b679", // Sage
  "3": "#8e24aa", // Grape
  "4": "#e67c73", // Flamingo
  "5": "#f6bf26", // Banana
  "6": "#f4511e", // Tangerine
  "7": "#039be5", // Peacock
  "8": "#616161", // Graphite
  "9": "#3f51b5", // Blueberry
  "10": "#0b8043", // Basil
  "11": "#d50000", // Tomato
};

/** Resolves a Google Calendar event's display color: its own colorId override when set, otherwise the given fallback (typically the source calendar's color). */
export function googleEventColor(colorId: string | null | undefined, fallback: string | null): string | null {
  if (colorId && GOOGLE_EVENT_COLOR_HEX[colorId]) return GOOGLE_EVENT_COLOR_HEX[colorId];
  return fallback;
}
