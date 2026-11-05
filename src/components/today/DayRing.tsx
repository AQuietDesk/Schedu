import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Panel } from "@/components/lo/primitives";
import { useContexts } from "@/hooks/useContexts";
import { useCalendarEventsInRangeForCalendars, useCalendarList, useGoogleConnected } from "@/hooks/useGoogle";
import { useCreateItem, useSoftDeleteItem, useUpdateItem } from "@/hooks/useItems";
import { useNowTick } from "@/hooks/useNowTick";
import { usePreferences, useSetPreference } from "@/hooks/usePreferences";
import { addDays, minutesFromTimeString, minutesToTimeString, parseDateOnly, toDateKey } from "@/lib/calendarGrid";
import { contextsMap, itemContextInfo, PERSONAL_HEX } from "@/lib/areas";
import {
  ADD_BLOCK_DURATION_MINUTES,
  angleToMinute,
  arcPath,
  buildHourTicks,
  buildInitialBlocks,
  DEFAULT_SLEEP_BEDTIME,
  DEFAULT_SLEEP_WAKE,
  easeOutBack,
  fmtDur,
  fmtTime,
  moveBlock,
  neighborLimits,
  openMinutes,
  pointOnRing,
  RING_CENTER,
  RING_RADIUS,
  setEdge,
  SLEEP_BEDTIME_PREF_KEY,
  SLEEP_WAKE_PREF_KEY,
  snapMinutes,
  unwrapNear,
  type GoogleRingEntry,
  type RingBlock,
} from "@/lib/dayRing";
import {
  parseSelectedCalendarIds,
  resolveCalendarIdsToQuery,
  SELECTED_CALENDARS_PREF_KEY,
} from "@/lib/googleCalendarSelection";
import { cn } from "@/lib/utils";
import type { Category, Context, GoogleCalendarEvent, Item } from "@/types";

const ADD_CATEGORY_CHOICES: { category: Category; label: string; color: string }[] = [
  { category: "School", label: "Study", color: "#2f6feb" },
  { category: "Personal", label: "Personal", color: PERSONAL_HEX },
];

const HOUR_TICKS = buildHourTicks();
const SPRING_MS = 220;

type DragState =
  | { kind: "edge"; blockId: string; edge: "start" | "end"; startClient: { x: number; y: number }; moved: boolean }
  | {
      kind: "move";
      blockId: string;
      startClient: { x: number; y: number };
      moved: boolean;
      initStart: number;
      initEnd: number;
      initRawUnwrapped: number;
    };

interface AddPopoverState {
  x: number;
  y: number;
  gapIndex: number;
  start: number;
  duration: number;
}

function blockColor(block: RingBlock, contextsById: Map<string, Context>): string {
  if (block.kind === "sleep") return "var(--day-ring-sleep)";
  if (block.kind === "google") return block.color ?? "var(--day-ring-google)";
  if (block.item) return itemContextInfo(block.item, contextsById).color;
  return block.category === "School" ? "#2f6feb" : PERSONAL_HEX;
}

// A single day, 24h ring — Sleep anchors it (a preference, not an Item),
// the rest of today's timed Items fill the waking hours, and whatever isn't
// covered reads as open. Drag a dot to resize the block on either side, drag
// the middle of a block to move it, or click open track to add one. See the
// "Day Ring" mockup this was built from for the full interaction rationale.
export function DayRing({ items }: { items: Item[] }) {
  const prefsQuery = usePreferences();
  const { data: contexts } = useContexts();
  const contextsById = useMemo(() => contextsMap(contexts), [contexts]);
  const setPreference = useSetPreference();
  const updateItem = useUpdateItem();
  const createItem = useCreateItem();
  const softDeleteItem = useSoftDeleteItem();
  const now = useNowTick(30_000);

  const bedtime = prefsQuery.data?.[SLEEP_BEDTIME_PREF_KEY] ?? DEFAULT_SLEEP_BEDTIME;
  const wake = prefsQuery.data?.[SLEEP_WAKE_PREF_KEY] ?? DEFAULT_SLEEP_WAKE;

  // Today's live Google Calendar events, merged into the ring alongside
  // Items — otherwise an event created directly in Google Calendar (never
  // pulled down as an Item, see sync.rs) would never appear here even though
  // it already shows on the Calendar page. Mirrors Calendar.tsx's own
  // primary-plus-selected-calendars query, just scoped to a single day.
  const { data: googleConnected } = useGoogleConnected();
  const { data: calendarList } = useCalendarList(!!googleConnected);
  const selectedCalendarIds = useMemo(
    () => parseSelectedCalendarIds(prefsQuery.data?.[SELECTED_CALENDARS_PREF_KEY]),
    [prefsQuery.data],
  );
  const calendarIdsToQuery = useMemo(
    () => resolveCalendarIdsToQuery(!!googleConnected, calendarList, selectedCalendarIds),
    [googleConnected, calendarList, selectedCalendarIds],
  );
  const colorByCalendarId = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const cal of calendarList ?? []) map.set(cal.id, cal.background_color ?? null);
    return map;
  }, [calendarList]);

  // Keyed off today's date, not the 30s `now` tick — the two only differ
  // once a day (at midnight), so this keeps the query range stable and
  // avoids refetching Google on every tick.
  const todayKey = toDateKey(now);
  const { timeMin, timeMax } = useMemo(() => {
    const start = parseDateOnly(todayKey);
    return { timeMin: start.toISOString(), timeMax: addDays(start, 1).toISOString() };
  }, [todayKey]);

  const eventQueries = useCalendarEventsInRangeForCalendars(calendarIdsToQuery, timeMin, timeMax, !!googleConnected);
  // `useQueries`'s returned array (and calendarIdsToQuery/colorByCalendarId
  // above) are new references on many renders even when nothing meaningful
  // changed — memoizing directly on them reruns this every render, which fed
  // a `setBlocks` effect below and produced an infinite render loop
  // ("Maximum update depth exceeded") that pegged the main thread and made
  // the whole app unresponsive. So instead of trusting any of those
  // references, this recomputes cheaply every render and then stabilizes the
  // *returned* reference by comparing a content key — it only actually
  // changes (and only then feeds the effect below) when an event's id,
  // last-updated timestamp, or calendar color genuinely changed.
  const googleEntriesRaw: GoogleRingEntry[] = [];
  eventQueries.forEach((query, i) => {
    const calendarId = calendarIdsToQuery[i];
    const color = colorByCalendarId.get(calendarId) ?? null;
    for (const event of (query.data as GoogleCalendarEvent[] | undefined) ?? []) {
      googleEntriesRaw.push({ event, color });
    }
  });
  const googleEntriesKey = googleEntriesRaw.map((e) => `${e.event.id}:${e.event.updated}:${e.color}`).join("|");
  const googleEntriesRef = useRef<{ key: string; entries: GoogleRingEntry[] }>({ key: "", entries: [] });
  if (googleEntriesRef.current.key !== googleEntriesKey) {
    googleEntriesRef.current = { key: googleEntriesKey, entries: googleEntriesRaw };
  }
  const googleEntries = googleEntriesRef.current.entries;

  const [blocks, setBlocks] = useState<RingBlock[]>(() => buildInitialBlocks(items, bedtime, wake, googleEntries));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pulse, setPulse] = useState<{ id: string; mode: "scale" | "flash" } | null>(null);
  const [addPopover, setAddPopover] = useState<AddPopoverState | null>(null);

  const blocksRef = useRef(blocks);
  const draggingRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  // Resync from source data (items/prefs changed, e.g. after a mutation's
  // refetch) — but never mid-gesture, or the block would jump under the
  // user's pointer.
  useEffect(() => {
    if (draggingRef.current) return;
    setBlocks(buildInitialBlocks(items, bedtime, wake, googleEntries));
  }, [items, bedtime, wake, googleEntries]);

  useEffect(() => {
    if (!pulse) return;
    const id = setTimeout(() => setPulse(null), 220);
    return () => clearTimeout(id);
  }, [pulse]);

  useEffect(() => {
    if (!addPopover) return;
    function onPointerDown(e: PointerEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setAddPopover(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [addPopover]);

  function clientToMinute(clientX: number, clientY: number): number {
    const svg = svgRef.current;
    if (!svg) return 0;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    const theta = Math.atan2(loc.y - RING_CENTER, loc.x - RING_CENTER);
    return angleToMinute(theta);
  }

  function persistBlock(blockId: string) {
    const block = blocksRef.current.find((b) => b.id === blockId);
    if (!block) return;
    if (block.kind === "sleep") {
      setPreference.mutate({ key: SLEEP_BEDTIME_PREF_KEY, value: minutesToTimeString(block.start) });
      setPreference.mutate({ key: SLEEP_WAKE_PREF_KEY, value: minutesToTimeString(block.end) });
    } else if (block.item) {
      updateItem.mutate({
        ...block.item,
        due_time: minutesToTimeString(block.start),
        estimated_duration: block.end - block.start,
      });
    }
  }

  function runSpring(blockId: string, target: { start: number; end: number }, onDone: () => void) {
    const from = blocksRef.current.find((b) => b.id === blockId);
    if (!from) return;
    const fromStart = from.start, fromEnd = from.end;
    const t0 = performance.now();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function frame(now: number) {
      const t = reduceMotion ? 1 : Math.min(1, (now - t0) / SPRING_MS);
      const e = easeOutBack(t);
      setBlocks((prev) =>
        prev.map((b) =>
          b.id === blockId
            ? { ...b, start: fromStart + (target.start - fromStart) * e, end: fromEnd + (target.end - fromEnd) * e }
            : b,
        ),
      );
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        setBlocks((prev) => prev.map((b) => (b.id === blockId ? { ...b, ...target } : b)));
        onDone();
      }
    }
    requestAnimationFrame(frame);
  }

  function selectBlock(id: string) {
    setSelectedId((cur) => (cur === id ? null : id));
  }

  // ---- edge (resize) drag ----
  function onHandlePointerDown(e: React.PointerEvent, blockId: string, edge: "start" | "end") {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    draggingRef.current = true;
    dragRef.current = { kind: "edge", blockId, edge, startClient: { x: e.clientX, y: e.clientY }, moved: false };
  }

  function onHandlePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.kind !== "edge") return;
    if (Math.abs(e.clientX - drag.startClient.x) + Math.abs(e.clientY - drag.startClient.y) > 3) drag.moved = true;
    if (!drag.moved) return;
    const raw = clientToMinute(e.clientX, e.clientY);
    setBlocks((prev) => {
      const next = prev.map((b) => ({ ...b }));
      const index = next.findIndex((b) => b.id === drag.blockId);
      if (index === -1) return prev;
      const current = next[index][drag.edge];
      const unwrapped = unwrapNear(raw, current);
      const hit = setEdge(next, index, drag.edge, unwrapped);
      if (hit) setPulse({ id: drag.blockId, mode: "scale" });
      return next;
    });
  }

  function onHandlePointerUp() {
    const drag = dragRef.current;
    if (!drag || drag.kind !== "edge") return;
    dragRef.current = null;
    if (!drag.moved) {
      draggingRef.current = false;
      selectBlock(drag.blockId);
      return;
    }
    const block = blocksRef.current.find((b) => b.id === drag.blockId);
    if (!block) {
      draggingRef.current = false;
      return;
    }
    const index = blocksRef.current.findIndex((b) => b.id === drag.blockId);
    const lim = neighborLimits(blocksRef.current, index);
    let target = snapMinutes(block[drag.edge]);
    if (drag.edge === "end") target = Math.min(Math.max(target, block.start + 15), lim.nextStartAbs);
    else target = Math.min(Math.max(target, lim.prevEndAbs), block.end - 15);
    const targetBlock = drag.edge === "end" ? { start: block.start, end: target } : { start: target, end: block.end };
    runSpring(drag.blockId, targetBlock, () => {
      draggingRef.current = false;
      persistBlock(drag.blockId);
    });
  }

  // ---- whole-block move drag ----
  function onBlockPointerDown(e: React.PointerEvent, blockId: string) {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const block = blocksRef.current.find((b) => b.id === blockId);
    if (!block) return;
    draggingRef.current = true;
    const raw = clientToMinute(e.clientX, e.clientY);
    const initRawUnwrapped = unwrapNear(raw, (block.start + block.end) / 2);
    dragRef.current = {
      kind: "move",
      blockId,
      startClient: { x: e.clientX, y: e.clientY },
      moved: false,
      initStart: block.start,
      initEnd: block.end,
      initRawUnwrapped,
    };
  }

  function onBlockPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.kind !== "move") return;
    if (Math.abs(e.clientX - drag.startClient.x) + Math.abs(e.clientY - drag.startClient.y) > 3) drag.moved = true;
    if (!drag.moved) return;
    const raw = clientToMinute(e.clientX, e.clientY);
    const unwrapped = unwrapNear(raw, drag.initRawUnwrapped);
    const delta = unwrapped - drag.initRawUnwrapped;
    setBlocks((prev) => {
      const next = prev.map((b) => ({ ...b }));
      const index = next.findIndex((b) => b.id === drag.blockId);
      if (index === -1) return prev;
      next[index].start = drag.initStart;
      next[index].end = drag.initEnd;
      const hit = moveBlock(next, index, delta);
      if (hit) setPulse({ id: drag.blockId, mode: "flash" });
      return next;
    });
  }

  function onBlockPointerUp() {
    const drag = dragRef.current;
    if (!drag || drag.kind !== "move") return;
    dragRef.current = null;
    if (!drag.moved) {
      draggingRef.current = false;
      selectBlock(drag.blockId);
      return;
    }
    const index = blocksRef.current.findIndex((b) => b.id === drag.blockId);
    const block = blocksRef.current[index];
    const duration = block.end - block.start;
    const lim = neighborLimits(blocksRef.current, index);
    const minStart = lim.prevEndAbs, maxStart = lim.nextStartAbs - duration;
    const targetStart = Math.min(Math.max(snapMinutes(block.start), minStart), maxStart);
    runSpring(drag.blockId, { start: targetStart, end: targetStart + duration }, () => {
      draggingRef.current = false;
      persistBlock(drag.blockId);
    });
  }

  // ---- keyboard nudge (edge handles) ----
  function onHandleKeyDown(e: React.KeyboardEvent, blockId: string, edge: "start" | "end") {
    let delta = 0;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") delta = e.shiftKey ? -30 : -5;
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") delta = e.shiftKey ? 30 : 5;
    else return;
    e.preventDefault();
    setBlocks((prev) => {
      const next = prev.map((b) => ({ ...b }));
      const index = next.findIndex((b) => b.id === blockId);
      if (index === -1) return prev;
      setEdge(next, index, edge, next[index][edge] + delta);
      return next;
    });
    persistBlock(blockId);
  }

  // ---- exact time entry (legend) ----
  function onTimeInputChange(blockId: string, edge: "start" | "end", value: string) {
    if (!value) return;
    setBlocks((prev) => {
      const next = prev.map((b) => ({ ...b }));
      const index = next.findIndex((b) => b.id === blockId);
      if (index === -1) return prev;
      const raw = minutesFromTimeString(value);
      const unwrapped = unwrapNear(raw, next[index][edge]);
      setEdge(next, index, edge, unwrapped);
      return next;
    });
    persistBlock(blockId);
  }

  function onRemoveBlock(block: RingBlock) {
    if (block.kind !== "item" || !block.item) return;
    if (selectedId === block.id) setSelectedId(null);
    softDeleteItem.mutate(block.item.id);
  }

  // ---- open track: click to add ----
  function onTrackClick(e: React.MouseEvent<SVGCircleElement>) {
    const raw = clientToMinute(e.clientX, e.clientY);
    const current = blocksRef.current;
    for (let i = 0; i < current.length; i++) {
      const lim = neighborLimits(current, i);
      const candidate = unwrapNear(raw, (current[i].end + lim.nextStartAbs) / 2);
      if (candidate >= current[i].end && candidate <= lim.nextStartAbs) {
        const gapStart = current[i].end, gapEnd = lim.nextStartAbs;
        if (gapEnd - gapStart < 10) return;
        const duration = Math.min(ADD_BLOCK_DURATION_MINUTES, gapEnd - gapStart);
        const start = Math.min(Math.max(candidate - duration / 2, gapStart), gapEnd - duration);
        setAddPopover({ x: e.clientX, y: e.clientY, gapIndex: i, start, duration });
        return;
      }
    }
  }

  async function onPickAddCategory(choice: { category: Category; label: string; color: string }) {
    if (!addPopover) return;
    setAddPopover(null);
    await createItem.mutateAsync({
      title: choice.label,
      category: choice.category,
      due_date: toDateKey(new Date()),
      due_time: minutesToTimeString(addPopover.start),
      estimated_duration: addPopover.duration,
    });
  }

  const selected = selectedId ? blocks.find((b) => b.id === selectedId) : null;
  const open = openMinutes(blocks);

  return (
    <Panel elevated title="Your day" action={<Link to="/calendar" className="hover:text-fg2">Calendar</Link>}>
        <div className="mx-auto flex w-full flex-col items-center gap-4">
          <div className="relative" style={{ width: 232, height: 232 }}>
            <svg ref={svgRef} viewBox="0 0 420 420" className="h-full w-full overflow-visible">
              <circle
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={RING_RADIUS}
                fill="none"
                stroke="var(--sunken)"
                strokeWidth={34}
                className="cursor-pointer"
                onClick={onTrackClick}
              />
              <g className="opacity-40">
                {HOUR_TICKS.map((t) => (
                  <line
                    key={t.hour}
                    x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
                    stroke="var(--fg3)"
                    strokeWidth={t.major ? 1.4 : 1}
                    opacity={t.major ? 1 : 0.6}
                  />
                ))}
              </g>
              {HOUR_TICKS.filter((t) => t.label).map((t) => (
                <text
                  key={t.hour}
                  x={t.labelX} y={t.labelY}
                  fontSize={19}
                  fontWeight={500}
                  fill="var(--fg3)"
                  fontFamily="var(--font-mono)"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {t.label}
                </text>
              ))}
              {blocks.map((block) => {
                const insetMin = Math.min(1.4, ((block.end - block.start) / 1440) * 360 * 0.18) / 360 * 1440;
                const color = blockColor(block, contextsById);
                const readOnly = block.kind === "google";
                return (
                  <path
                    key={block.id}
                    d={arcPath(block.start + insetMin, block.end - insetMin, RING_RADIUS)}
                    fill="none"
                    stroke={color}
                    strokeWidth={30}
                    strokeLinecap="round"
                    className={cn(
                      readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
                      block.id === selectedId && "brightness-110",
                      pulse?.id === block.id && pulse.mode === "flash" && "[animation:day-ring-pulse-flash_220ms_ease]",
                    )}
                    style={{ touchAction: "none" }}
                    onClick={readOnly ? () => selectBlock(block.id) : undefined}
                    onPointerDown={readOnly ? undefined : (e) => onBlockPointerDown(e, block.id)}
                    onPointerMove={readOnly ? undefined : onBlockPointerMove}
                    onPointerUp={readOnly ? undefined : onBlockPointerUp}
                    onPointerCancel={readOnly ? undefined : onBlockPointerUp}
                  >
                    <title>{block.label}</title>
                  </path>
                );
              })}
              {blocks.filter((block) => block.kind !== "google").map((block) => {
                const color = blockColor(block, contextsById);
                const p1 = pointOnRing(block.start, RING_RADIUS);
                const p2 = pointOnRing(block.end, RING_RADIUS);
                return (
                  <g key={block.id}>
                    <circle
                      cx={p1.x} cy={p1.y} r={9}
                      fill="var(--card)" stroke={color} strokeWidth={3}
                      tabIndex={0}
                      role="slider"
                      aria-label={`${block.label} start`}
                      aria-valuetext={fmtTime(block.start)}
                      className={cn(
                        "cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
                        pulse?.id === block.id && pulse.mode === "scale" && "[animation:day-ring-pulse-scale_220ms_ease]",
                      )}
                      style={{ touchAction: "none" }}
                      onPointerDown={(e) => onHandlePointerDown(e, block.id, "start")}
                      onPointerMove={onHandlePointerMove}
                      onPointerUp={onHandlePointerUp}
                      onPointerCancel={onHandlePointerUp}
                      onKeyDown={(e) => onHandleKeyDown(e, block.id, "start")}
                    />
                    <circle
                      cx={p2.x} cy={p2.y} r={9}
                      fill="var(--card)" stroke={color} strokeWidth={3}
                      tabIndex={0}
                      role="slider"
                      aria-label={`${block.label} end`}
                      aria-valuetext={fmtTime(block.end)}
                      className={cn(
                        "cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
                        pulse?.id === block.id && pulse.mode === "scale" && "[animation:day-ring-pulse-scale_220ms_ease]",
                      )}
                      style={{ touchAction: "none" }}
                      onPointerDown={(e) => onHandlePointerDown(e, block.id, "end")}
                      onPointerMove={onHandlePointerMove}
                      onPointerUp={onHandlePointerUp}
                      onPointerCancel={onHandlePointerUp}
                      onKeyDown={(e) => onHandleKeyDown(e, block.id, "end")}
                    />
                  </g>
                );
              })}
              {(() => {
                const nowMin = now.getHours() * 60 + now.getMinutes();
                const p1 = pointOnRing(nowMin, 124);
                const p2 = pointOnRing(nowMin, 192);
                const pd = pointOnRing(nowMin, 196);
                return (
                  <>
                    <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--foreground)" strokeWidth={2} />
                    <circle cx={pd.x} cy={pd.y} r={5} fill="var(--foreground)" />
                  </>
                );
              })()}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-[18%] text-center">
              {selected ? (
                <>
                  <div className="mb-1 flex max-w-full items-center gap-1.5 truncate text-[13px] font-semibold">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: blockColor(selected, contextsById) }} />
                    {selected.label}
                  </div>
                  <div className="text-xl font-semibold tabular-nums leading-none">{fmtDur(selected.end - selected.start)}</div>
                  <div className="mt-1 text-[11px] text-fg3">
                    {fmtTime(selected.start)} – {fmtTime(selected.end)}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[26px] font-semibold tracking-tight tabular-nums leading-none">
                    {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  </div>
                  <div className="mt-1.5 text-xs text-fg3">{fmtDur(open)} open today</div>
                </>
              )}
            </div>
          </div>

          <ul className="w-full text-[13.5px]">
            {blocks.map((block) => {
              const isOpen = block.id === selectedId;
              const color = blockColor(block, contextsById);
              return (
                <li key={block.id}>
                  <button
                    type="button"
                    className={cn("flex h-[30px] w-full items-center gap-2.5 rounded-md px-1 text-left hover:bg-sunken", isOpen && "bg-sunken")}
                    onClick={() => selectBlock(block.id)}
                  >
                    <span className="w-[62px] shrink-0 font-mono text-xs text-fg3">{fmtTime(block.start)}</span>
                    <span className="size-2 shrink-0 rounded-[3px]" style={{ background: color }} />
                    <span className="flex-1 truncate">{block.label}</span>
                    <span className="text-xs tabular-nums text-fg3">{fmtDur(block.end - block.start)}</span>
                  </button>
                  {isOpen && block.kind !== "google" && (
                    <div className="flex flex-wrap items-center gap-2 py-1.5 pl-[74px]">
                      <input
                        type="time"
                        value={minutesToTimeString(block.start)}
                        onChange={(e) => onTimeInputChange(block.id, "start", e.target.value)}
                        className="rounded-md border border-line bg-card px-1.5 py-1 text-xs"
                      />
                      <span className="text-xs text-muted-foreground">&ndash;</span>
                      <input
                        type="time"
                        value={minutesToTimeString(block.end)}
                        onChange={(e) => onTimeInputChange(block.id, "end", e.target.value)}
                        className="rounded-md border border-line bg-card px-1.5 py-1 text-xs"
                      />
                      {block.kind === "item" && (
                        <button
                          type="button"
                          className="ml-auto text-xs text-danger hover:underline"
                          onClick={() => onRemoveBlock(block)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="w-full text-xs text-fg3">Drag a block’s ends to resize it, or click the empty track to add time.</p>
        </div>

        {addPopover && (
          <div
            ref={popoverRef}
            className="fixed z-50 flex gap-1 rounded-xl border border-line bg-popover p-1 shadow-pop"
            style={{ left: Math.max(8, addPopover.x - 80), top: addPopover.y + 12 }}
          >
            {ADD_CATEGORY_CHOICES.map((choice) => (
              <button
                key={choice.category}
                type="button"
                className="flex h-8 items-center gap-2 rounded-lg px-3 text-sm hover:bg-sunken"
                onClick={() => onPickAddCategory(choice)}
              >
                <span className="size-2 rounded-[3px]" style={{ background: choice.color }} />
                {choice.label}
              </button>
            ))}
          </div>
        )}
    </Panel>
  );
}
