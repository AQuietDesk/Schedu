import { minutesFromTimeString, toDateKey } from "@/lib/calendarGrid";
import { daysUntil } from "@/lib/dates";
import { googleEventColor } from "@/lib/googleEventColors";
import type { Category, GoogleCalendarEvent, Item } from "@/types";

// Mirrors Calendar.tsx's own local DEFAULT_DURATION_MINUTES — kept as a
// separate constant here rather than a shared import since the two views
// (week grid vs. day ring) have no other coupling and a single "default
// event length" literal isn't worth a cross-file dependency on its own.
export const DEFAULT_ITEM_DURATION_MINUTES = 60;
export const ADD_BLOCK_DURATION_MINUTES = 30;
export const MIN_BLOCK_MINUTES = 15;

export const SLEEP_BEDTIME_PREF_KEY = "sleep_bedtime";
export const SLEEP_WAKE_PREF_KEY = "sleep_wake_time";
export const DEFAULT_SLEEP_BEDTIME = "23:00";
export const DEFAULT_SLEEP_WAKE = "07:00";

export interface RingBlock {
  id: string;
  kind: "sleep" | "item" | "google";
  label: string;
  category: Category | null;
  /** Absolute minutes — always in [0, 1440) for `start`; `end` may exceed
   *  1440 when the block crosses midnight (e.g. an overnight Sleep block).
   *  Blocks are kept in a single ascending, non-overlapping sequence, so a
   *  block's index-adjacent neighbors are always its true ring neighbors. */
  start: number;
  end: number;
  item?: Item;
  /** Resolved display color for a "google" block (event's own colorId, falling back to its calendar's color) — Items use their category color instead. */
  color?: string | null;
}

/** A Google Calendar event paired with the fallback display color of the calendar it came from (used when the event has no colorId of its own). */
export interface GoogleRingEntry {
  event: GoogleCalendarEvent;
  color: string | null;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Shifts `value` by whole days (±1440) until it lands within 12h of `reference` — the standard trick for reasoning about a circular quantity (angle, time-of-day) as a plain ordered number. */
export function unwrapNear(value: number, reference: number): number {
  let v = value;
  while (v - reference > 720) v -= 1440;
  while (v - reference < -720) v += 1440;
  return v;
}

function sleepBlock(bedtime: string, wake: string): RingBlock {
  const start = minutesFromTimeString(bedtime);
  let end = minutesFromTimeString(wake);
  if (end <= start) end += 1440;
  return { id: "sleep", kind: "sleep", label: "Sleep", category: null, start, end };
}

/** Sorts blocks by start time, then nudges any later block whose start lands
 *  before the previous block's end up to that end, preserving durations —
 *  real-world data can have two things genuinely scheduled at once, and this
 *  keeps the ring's neighbor-clamped drag math from choking on the overlap. */
function sortAndCompact(blocks: RingBlock[]): RingBlock[] {
  blocks.sort((a, b) => a.start - b.start);
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].start < blocks[i - 1].end) {
      const shift = blocks[i - 1].end - blocks[i].start;
      blocks[i].start += shift;
      blocks[i].end += shift;
    }
  }
  return blocks;
}

/**
 * Builds today's ring blocks from Sleep (a fixed daily anchor from
 * preferences, not an Item), any of today's Items that have a due_time, and
 * today's live Google Calendar events that aren't already represented by one
 * of those Items (an event this app itself pushed to Google shows up in both
 * places otherwise). Items/events without a time have no natural place on a
 * 24h ring, so they're left for the list-based widgets instead. This
 * recomputes from source data on every call, so a compacted position from
 * `sortAndCompact` is display-only unless the user then actually drags that block.
 */
export function buildInitialBlocks(
  items: Item[],
  bedtime: string,
  wake: string,
  googleEntries: GoogleRingEntry[] = [],
): RingBlock[] {
  const blocks: RingBlock[] = [sleepBlock(bedtime, wake)];

  // Everything due today (completed included — the ring is a picture of the
  // whole day, not a work-remaining list).
  const today = items
    .filter((i) => daysUntil(i.due_date) === 0)
    .sort((a, b) => (a.due_time ?? "99:99").localeCompare(b.due_time ?? "99:99"));
  for (const item of today) {
    if (!item.due_time) continue;
    const start = minutesFromTimeString(item.due_time);
    const end = start + (item.estimated_duration ?? DEFAULT_ITEM_DURATION_MINUTES);
    blocks.push({ id: item.id, kind: "item", label: item.title, category: item.category, start, end, item });
  }

  const knownGoogleIds = new Set(items.map((i) => i.google_calendar_id).filter((id): id is string => !!id));
  const todayKey = toDateKey(new Date());
  for (const { event, color } of googleEntries) {
    if (event.status === "cancelled") continue;
    if (knownGoogleIds.has(event.id)) continue; // already represented above as an item
    const dateTime = event.start?.dateTime;
    if (!dateTime) continue; // all-day event — no natural place on the ring
    if (dateTime.slice(0, 10) !== todayKey) continue; // multi-day event that only overlaps today

    const start = minutesFromTimeString(dateTime.slice(11, 16));
    const endDateTime = event.end?.dateTime;
    const durationMinutes = endDateTime
      ? Math.max(15, Math.round((new Date(endDateTime).getTime() - new Date(dateTime).getTime()) / 60_000))
      : DEFAULT_ITEM_DURATION_MINUTES;
    blocks.push({
      id: `gcal-${event.id}`,
      kind: "google",
      label: event.summary ?? "(untitled)",
      category: null,
      start,
      end: start + durationMinutes,
      color: googleEventColor(event.color_id, color),
    });
  }

  return sortAndCompact(blocks);
}

export function neighborLimits(blocks: RingBlock[], i: number): { prevEndAbs: number; nextStartAbs: number } {
  const n = blocks.length;
  const prevEndAbs = i === 0 ? blocks[n - 1].end - 1440 : blocks[i - 1].end;
  const nextStartAbs = i === n - 1 ? blocks[0].start + 1440 : blocks[i + 1].start;
  return { prevEndAbs, nextStartAbs };
}

/** Mutates blocks[i][edge] in place, clamped to its neighbors and a minimum duration. Returns whether the requested value had to be clamped (i.e. the drag hit a wall). */
export function setEdge(blocks: RingBlock[], i: number, edge: "start" | "end", absValue: number): boolean {
  const b = blocks[i];
  const { prevEndAbs, nextStartAbs } = neighborLimits(blocks, i);
  let clamped: number;
  if (edge === "end") {
    clamped = Math.min(Math.max(absValue, b.start + MIN_BLOCK_MINUTES), nextStartAbs);
    b.end = clamped;
  } else {
    clamped = Math.min(Math.max(absValue, prevEndAbs), b.end - MIN_BLOCK_MINUTES);
    b.start = clamped;
  }
  return clamped !== absValue;
}

/** Mutates blocks[i]'s start & end together (same duration, new position), clamped so neither edge crosses a neighbor. Returns whether the drag hit a wall. */
export function moveBlock(blocks: RingBlock[], i: number, deltaMinutes: number): boolean {
  const b = blocks[i];
  const duration = b.end - b.start;
  const { prevEndAbs, nextStartAbs } = neighborLimits(blocks, i);
  const deltaMin = prevEndAbs - b.start;
  const deltaMax = nextStartAbs - b.end;
  const clampedDelta = Math.min(Math.max(deltaMinutes, deltaMin), deltaMax);
  b.start += clampedDelta;
  b.end = b.start + duration;
  return clampedDelta !== deltaMinutes;
}

export function openMinutes(blocks: RingBlock[]): number {
  const used = blocks.reduce((sum, b) => sum + (b.end - b.start), 0);
  return Math.max(0, 1440 - used);
}

// ---------------------------------------------------------------------
// Ring geometry — midnight at the top (12 o'clock), clockwise. All radii
// are in the SVG's own viewBox units, scaled to whatever size the <svg>
// is rendered at.
// ---------------------------------------------------------------------
export const RING_CENTER = 210;
export const RING_RADIUS = 160;

function angleRad(absMin: number): number {
  return (mod(absMin, 1440) / 1440) * Math.PI * 2 - Math.PI / 2;
}

export function pointOnRing(absMin: number, r: number, cx = RING_CENTER, cy = RING_CENTER): { x: number; y: number } {
  const a = angleRad(absMin);
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

export function arcPath(start: number, end: number, r: number, cx = RING_CENTER, cy = RING_CENTER): string {
  const p1 = pointOnRing(start, r, cx, cy);
  const p2 = pointOnRing(end, r, cx, cy);
  const largeArc = end - start > 720 ? 1 : 0;
  return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
}

/** Converts an angle (radians, atan2 convention: 0 = 3 o'clock) into absolute minutes-of-day in [0, 1440). */
export function angleToMinute(theta: number): number {
  return mod(((theta + Math.PI / 2) / (Math.PI * 2)) * 1440, 1440);
}

export function fmtTime(absMin: number): string {
  const m = mod(absMin, 1440);
  let h = Math.floor(m / 60);
  let mm = Math.round(m % 60);
  if (mm === 60) { mm = 0; h += 1; }
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${ampm}`;
}

export function fmtDur(mins: number): string {
  const rounded = Math.round(mins);
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** Ease-out-back — a slight overshoot before settling, for the "stretchy" snap-to-grid feel when a drag is released. */
export function easeOutBack(t: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function snapMinutes(value: number, grid = 5): number {
  return Math.round(value / grid) * grid;
}

export interface HourTick {
  hour: number;
  major: boolean;
  x1: number; y1: number; x2: number; y2: number;
  label?: string;
  labelX?: number; labelY?: number;
}

const HOUR_LABELS: Record<number, string> = { 0: "12A", 6: "6A", 12: "12P", 18: "6P" };

/** Static per-hour tick geometry around the ring — pure function of the ring's own radius, so it's the same every render; callers can memoize once. */
export function buildHourTicks(cx = RING_CENTER, cy = RING_CENTER): HourTick[] {
  const ticks: HourTick[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const major = hour % 6 === 0;
    const r1 = major ? 178 : 180;
    const r2 = major ? 191 : 186;
    const p1 = pointOnRing(hour * 60, r1, cx, cy);
    const p2 = pointOnRing(hour * 60, r2, cx, cy);
    const tick: HourTick = { hour, major, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    if (major) {
      const lp = pointOnRing(hour * 60, 203, cx, cy);
      tick.label = HOUR_LABELS[hour];
      tick.labelX = lp.x;
      tick.labelY = lp.y;
    }
    ticks.push(tick);
  }
  return ticks;
}
