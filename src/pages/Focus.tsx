import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle2, ChevronLeft, Circle, Pause, Play, X } from "lucide-react";
import { FocusReflection } from "@/components/focus/FocusReflection";
import { Dot, Kbd, Segmented } from "@/components/lo/primitives";
import { useContexts } from "@/hooks/useContexts";
import { useFocusSessions } from "@/hooks/useFocusSessions";
import { useItems } from "@/hooks/useItems";
import { usePreferences, useSetPreference } from "@/hooks/usePreferences";
import { contextsMap, itemArea, itemContextInfo } from "@/lib/areas";
import { formatFocusDuration, recentSessions, sessionsToday, todayFocusedSeconds, weekFocusedSeconds } from "@/lib/focusStatistics";
import { elapsedSeconds, formatClock, remainingSeconds } from "@/lib/focusTiming";
import { formatDue, isDone, todayItems } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import { useFocusStore } from "@/store/focusStore";
import type { Area } from "@/lib/areas";
import type { FocusSession, Item } from "@/types";

const DURATIONS: { key: string; label: string; seconds: number | null }[] = [
  { key: "25", label: "25 min", seconds: 25 * 60 },
  { key: "50", label: "50 min", seconds: 50 * 60 },
  { key: "90", label: "90 min", seconds: 90 * 60 },
  { key: "open", label: "Open", seconds: null },
];
const LAST_SESSION_PREF_KEY = "focus_last_session";

function breakFor(seconds: number | null): number {
  if (seconds === null || seconds <= 25 * 60) return 5 * 60;
  return seconds >= 90 * 60 ? 15 * 60 : 10 * 60;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

// ---------------------------------------------------------------------------
// Start screen
// ---------------------------------------------------------------------------

function StartScreen() {
  const [params] = useSearchParams();
  const { data: items = [] } = useItems();
  const { data: contexts } = useContexts();
  const { data: prefs } = usePreferences();
  const setPreference = useSetPreference();
  const startSession = useFocusStore((s) => s.startSession);
  const byId = useMemo(() => contextsMap(contexts), [contexts]);

  const [intent, setIntent] = useState("");
  const [goal, setGoal] = useState("");
  const [itemId, setItemId] = useState<string | null>(null);
  const [area, setArea] = useState<Area>("School");
  const [durationKey, setDurationKey] = useState("50");
  const [starting, setStarting] = useState(false);

  // Prefill: a task passed in (?item=) wins, else the last session's settings.
  useEffect(() => {
    const fromParam = params.get("item");
    const item = fromParam ? items.find((i) => i.id === fromParam) : undefined;
    if (item) {
      setItemId(item.id);
      setIntent(item.title);
      setArea(itemArea(item));
      return;
    }
    if (!prefs) return;
    try {
      const last = JSON.parse(prefs[LAST_SESSION_PREF_KEY] ?? "null") as { durationSeconds?: number | null } | null;
      if (last && "durationSeconds" in last) {
        setDurationKey(DURATIONS.find((d) => d.seconds === last.durationSeconds)?.key ?? "50");
      }
    } catch {
      /* ignore a malformed preference */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, items.length > 0, !!prefs]);

  const suggestions = useMemo(() => {
    const today = todayItems(items).filter((i) => !isDone(i));
    const linked = itemId ? items.find((i) => i.id === itemId) : undefined;
    const list = linked && !today.includes(linked) ? [linked, ...today] : today;
    return list.slice(0, 5);
  }, [items, itemId]);

  const pick = (item: Item) => {
    if (itemId === item.id) {
      setItemId(null);
      return;
    }
    setItemId(item.id);
    setIntent(item.title);
    setArea(itemArea(item));
  };

  const duration = DURATIONS.find((d) => d.key === durationKey) ?? DURATIONS[1];
  const endsAt = duration.seconds ? new Date(Date.now() + duration.seconds * 1000) : null;
  const linkedItem = itemId ? items.find((i) => i.id === itemId) : undefined;

  const start = async () => {
    if (!intent.trim() || starting) return;
    setStarting(true);
    try {
      await startSession({
        intent: intent.trim(),
        goal: goal.trim() || null,
        item_id: itemId,
        category: linkedItem ? linkedItem.category : area,
        planned_duration_seconds: duration.seconds,
        break_duration_seconds: breakFor(duration.seconds),
      });
      setPreference.mutate({
        key: LAST_SESSION_PREF_KEY,
        value: JSON.stringify({ intent: intent.trim(), itemId, durationSeconds: duration.seconds }),
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-10 px-6 pb-14 pt-20">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-[36px] font-semibold tracking-[-0.025em]">What are you focusing on?</h1>
        <p className="text-[15px] text-fg2">Pick a task or type an intention.</p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
        className="flex flex-col gap-10"
      >
        <section className="flex flex-col rounded-[20px] border border-line bg-card p-2 shadow-soft">
          <label className="flex h-14 items-center gap-3 border-b border-line px-4">
            <input
              autoFocus
              aria-label="Focus intention"
              placeholder="e.g. Lab 5 — pandas time series"
              value={intent}
              onChange={(e) => {
                setIntent(e.target.value);
                if (linkedItem && e.target.value !== linkedItem.title) setItemId(null);
              }}
              className="min-w-0 flex-1 bg-transparent text-lg tracking-[-0.01em] outline-none placeholder:text-fg3"
            />
            {linkedItem ? (
              <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-sunken px-2.5 py-1 text-[12.5px] text-fg2">
                <Dot color={itemContextInfo(linkedItem, byId).color} />
                {itemContextInfo(linkedItem, byId).label}
              </span>
            ) : (
              <Segmented<Area>
                label="Area"
                size="sm"
                value={area}
                onChange={setArea}
                options={[
                  { value: "School", label: "School" },
                  { value: "Personal", label: "Personal" },
                ]}
              />
            )}
          </label>
          <input
            aria-label="Goal for this session (optional)"
            placeholder="Goal for this session (optional)"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            className="h-11 border-b border-line bg-transparent px-4 text-sm outline-none placeholder:text-fg3"
          />
          {suggestions.length > 0 && (
            <>
              <span className="px-4 pb-1 pt-3 text-xs font-medium text-fg3">From today</span>
              {suggestions.map((item) => {
                const info = itemContextInfo(item, byId);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => pick(item)}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-[10px] px-4 text-left text-sm",
                      itemId === item.id ? "bg-brand-soft" : "hover:bg-sunken",
                    )}
                  >
                    <Dot color={info.color} />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="shrink-0 text-[12.5px] text-fg3">{formatDue(item)}</span>
                  </button>
                );
              })}
            </>
          )}
        </section>

        <div className="flex flex-col items-center gap-3">
          <span className="text-[13px] font-medium text-fg3">Session length</span>
          <div role="radiogroup" aria-label="Session length" className="flex flex-wrap justify-center gap-2">
            {DURATIONS.map((d) => (
              <button
                key={d.key}
                type="button"
                role="radio"
                aria-checked={durationKey === d.key}
                onClick={() => setDurationKey(d.key)}
                className={cn(
                  "h-11 min-w-[88px] rounded-xl px-4 text-[15px] font-medium transition-colors",
                  durationKey === d.key ? "border-[1.5px] border-foreground bg-card" : "border border-line2 text-fg2 hover:bg-hover",
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
          <span className="text-[13px] text-fg3">
            {endsAt
              ? `Then a ${breakFor(duration.seconds) / 60}-minute break · ends at ${endsAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
              : "Counts up until you finish"}
          </span>
        </div>

        <div className="flex justify-center">
          <button
            type="submit"
            disabled={!intent.trim() || starting}
            className="inline-flex h-[52px] items-center gap-2.5 rounded-full bg-primary px-10 text-base font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Play className="size-4 fill-current" />
            Start focus
          </button>
        </div>
      </form>

      <FocusHistory />
    </div>
  );
}

function OutcomeIcon({ session }: { session: FocusSession }) {
  if (session.outcome === "completed") return <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Completed" />;
  if (session.outcome === "interrupted") return <X className="size-4 shrink-0 text-fg3" aria-label="Interrupted" />;
  if (session.outcome === "partial") return <span className="w-4 text-center text-xs text-fg3" aria-label="Partly done">~</span>;
  return <Circle className="size-4 shrink-0 text-fg3" aria-label="Not completed" />;
}

function FocusHistory() {
  const { data } = useFocusSessions();
  const sessions = data ?? [];
  const recent = recentSessions(sessions, 6);
  return (
    <div className="flex flex-col gap-4 border-t border-line pt-6">
      <div className="flex flex-wrap justify-between gap-4 text-[13.5px] text-fg2">
        <span>
          Today <span className="font-semibold text-foreground">{formatFocusDuration(todayFocusedSeconds(sessions))}</span> ·{" "}
          {sessionsToday(sessions).length} session{sessionsToday(sessions).length === 1 ? "" : "s"}
        </span>
        <span>
          This week <span className="font-semibold text-foreground">{formatFocusDuration(weekFocusedSeconds(sessions))}</span>
        </span>
        <Link to="/stats" className="text-fg3 hover:text-fg2">
          Stats →
        </Link>
      </div>
      {recent.length > 0 && (
        <ul className="flex flex-col">
          {recent.map((s) => (
            <li key={s.id} className="flex min-h-10 items-center gap-3 border-b border-line text-sm last:border-b-0">
              <OutcomeIcon session={s} />
              <span className="min-w-0 flex-1 truncate">{s.intent}</span>
              <span className="shrink-0 text-xs text-fg3">
                {new Date(s.started_at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
              </span>
              <span className="w-14 shrink-0 text-right font-mono text-xs text-fg2">{formatFocusDuration(s.actual_duration_seconds ?? 0)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full-window session
// ---------------------------------------------------------------------------

function Ring({ fraction, children }: { fraction: number; children: React.ReactNode }) {
  const size = 340;
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <div className="relative" style={{ width: size, height: size, maxWidth: "80vw", maxHeight: "80vw" }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="size-full" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} stroke="var(--sunken)" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          stroke="var(--success)"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamped)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="transition-[stroke-dashoffset] duration-1000 ease-linear"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">{children}</div>
    </div>
  );
}

function SessionView({ session }: { session: FocusSession }) {
  const navigate = useNavigate();
  const { pause, resume, completePhase, abandon, endBreak } = useFocusStore();
  useFocusStore((s) => s.tick); // re-render once a second while ticking
  const { data: items } = useItems();
  const { data: contexts } = useContexts();
  const [reflected, setReflected] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  useEffect(() => setReflected(false), [session.id]);

  const now = new Date();
  const elapsed = elapsedSeconds(session, now);
  const remaining = remainingSeconds(session, now);
  const paused = session.running_since === null;
  const isBreak = session.phase === "break";
  const openFocus = session.planned_duration_seconds === null;
  const total = isBreak ? session.break_duration_seconds : (session.planned_duration_seconds ?? 0);
  const item = session.item_id ? items?.find((i) => i.id === session.item_id) : undefined;
  const info = item ? itemContextInfo(item, contextsMap(contexts)) : null;
  const endsAt = remaining !== null && !paused ? new Date(now.getTime() + remaining * 1000) : null;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (e.key === "Escape") navigate("/");
      if (e.key === " " && !isBreak) {
        e.preventDefault();
        void (paused ? resume() : pause());
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paused, isBreak, pause, resume, navigate]);

  return (
    <div className="dark fixed inset-0 z-30 flex flex-col items-center overflow-y-auto bg-[#111111] px-6 pb-10 pt-7 text-foreground">
      <div className="flex w-full max-w-[1280px] items-center justify-between gap-3 text-[13.5px] text-fg3">
        <button type="button" onClick={() => navigate("/")} className="flex h-9 items-center gap-2 rounded-lg pl-2 pr-3 hover:bg-hover">
          <ChevronLeft className="size-4" />
          Back
          <Kbd>Esc</Kbd>
        </button>
        <span>{isBreak ? "Break" : paused ? "Paused" : "Focusing · the timer keeps running if you leave"}</span>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-9 py-6">
        {isBreak && !reflected && (
          <div className="w-full max-w-md">
            <FocusReflection session={session} onDone={() => setReflected(true)} />
          </div>
        )}

        <div className="flex flex-col items-center gap-2.5 text-center">
          {info && (
            <span className="flex items-center gap-2 text-[13px] text-fg2">
              <Dot color={info.color} />
              {info.label}
            </span>
          )}
          <h1 className="text-[26px] font-medium tracking-[-0.015em]">{isBreak ? "Take a breather" : session.intent}</h1>
          {!isBreak && session.goal && <p className="text-sm text-fg2">{session.goal}</p>}
        </div>

        {openFocus && !isBreak ? (
          <div className="flex flex-col items-center gap-2 py-10">
            <span className="text-[76px] font-light tracking-[-0.04em] tabular-nums">{formatClock(elapsed)}</span>
            <span className="text-sm text-fg3">Open focus</span>
          </div>
        ) : (
          <Ring fraction={total ? elapsed / total : 0}>
            <span className="text-[76px] font-light leading-none tracking-[-0.04em] tabular-nums">{formatClock(remaining ?? 0)}</span>
            <span className="text-sm text-fg3">
              of {Math.round(total / 60)} min{endsAt ? ` · ends ${endsAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : ""}
            </span>
          </Ring>
        )}

        {isBreak ? (
          <button type="button" onClick={() => void endBreak()} className="h-12 rounded-full border border-line2 px-6 text-[14.5px] text-fg2 hover:bg-hover">
            Skip break
          </button>
        ) : (
          <div className="flex items-center gap-3.5">
            <button
              type="button"
              onClick={() => void completePhase()}
              className="h-12 rounded-full border border-line2 px-5 text-[14.5px] text-fg2 hover:bg-hover"
            >
              Finish
            </button>
            <button
              type="button"
              aria-label={paused ? "Resume (Space)" : "Pause (Space)"}
              onClick={() => void (paused ? resume() : pause())}
              className="flex size-[72px] items-center justify-center rounded-full bg-foreground text-background"
            >
              {paused ? <Play className="size-6 fill-current" /> : <Pause className="size-6 fill-current" />}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!confirmEnd) {
                  setConfirmEnd(true);
                  setTimeout(() => setConfirmEnd(false), 3000);
                  return;
                }
                void abandon();
              }}
              className={cn("h-12 rounded-full border px-5 text-[14.5px]", confirmEnd ? "border-danger text-danger" : "border-line2 text-fg2 hover:bg-hover")}
            >
              {confirmEnd ? "End now?" : "End"}
            </button>
          </div>
        )}
        {!isBreak && (
          <span className="text-[12.5px] text-fg3">
            <Kbd>Space</Kbd> pause · Finish starts your break · End stops without one
          </span>
        )}
      </div>
    </div>
  );
}

export default function Focus() {
  const session = useFocusStore((s) => s.session);
  return session ? <SessionView session={session} /> : <StartScreen />;
}
