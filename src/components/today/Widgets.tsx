import { useState } from "react";
import { Link } from "react-router-dom";
import { Bell, X } from "lucide-react";
import { Dot, Panel } from "@/components/lo/primitives";
import { useFocusSessions } from "@/hooks/useFocusSessions";
import { useCreateQuickNote, useDeleteQuickNote, useQuickNotes } from "@/hooks/useQuickNotes";
import { useUpcomingNotifications } from "@/hooks/useUpcomingNotifications";
import { useWeather } from "@/hooks/useWeather";
import { itemContextInfo } from "@/lib/areas";
import { formatFocusDuration, sessionsToday, todayFocusedSeconds } from "@/lib/focusStatistics";
import { relativeDueLabel } from "@/lib/notificationEngine";
import { weatherCodeInfo } from "@/lib/weather";
import { cn } from "@/lib/utils";
import { useFocusStore } from "@/store/focusStore";
import { usePeekStore } from "@/store/peekStore";
import type { Context, Item } from "@/types";

export function WeatherChip() {
  const { data } = useWeather();
  if (!data) return null;
  const { icon: Icon, label } = weatherCodeInfo(data.currentCode);
  return (
    <span className="flex items-center gap-1.5 px-2 text-[13px] text-fg2" title={`${label} · H ${Math.round(data.todayHigh)}° L ${Math.round(data.todayLow)}°`}>
      <Icon className="size-4" />
      {Math.round(data.currentTemp)}° {label} · {data.locationLabel.split(",")[0]}
    </span>
  );
}

/**
 * Replaces the old pop-up Notification Center. Same engine and rules
 * (window, priority overrides, "already shown today"), but it sits quietly
 * at the top of Today instead of blocking the screen with a modal.
 */
export function AttentionStrip({ items, itemsReady, contextsById }: { items: Item[]; itemsReady: boolean; contextsById: Map<string, Context> }) {
  const { candidates: all, dismissOne, dismissAll } = useUpcomingNotifications(items, itemsReady);
  // Overdue and due-today items are already front and centre in the Today
  // list right below, so this only calls out what's further ahead.
  const candidates = all.filter((c) => c.days >= 1);
  const openPeek = usePeekStore((s) => s.open);
  const [expanded, setExpanded] = useState(false);
  if (candidates.length === 0) return null;
  const shown = expanded ? candidates : candidates.slice(0, 3);

  return (
    <section aria-label="Needs attention" className="flex flex-col gap-1 rounded-2xl bg-brand-soft p-2">
      <div className="flex items-center justify-between px-3 pb-1 pt-1.5">
        <span className="flex items-center gap-2 text-[13px] font-medium text-brand">
          <Bell className="size-3.5" />
          {candidates.length} deadline{candidates.length === 1 ? "" : "s"} ahead
        </span>
        <button type="button" onClick={dismissAll} className="text-[13px] text-brand/80 hover:text-brand">
          Dismiss all
        </button>
      </div>
      {shown.map(({ item, days, urgency }) => {
        const info = itemContextInfo(item, contextsById);
        return (
          <div key={item.id} className="flex min-h-10 items-center gap-3 rounded-[10px] bg-card px-3">
            <Dot color={info.color} />
            <button type="button" onClick={() => openPeek(item.id)} className="min-w-0 flex-1 truncate text-left text-sm hover:underline">
              {item.title}
            </button>
            <span className={cn("shrink-0 text-[12.5px]", urgency === "overdue" ? "font-medium text-danger" : "text-fg3")}>
              {relativeDueLabel(item, days)}
            </span>
            <button
              type="button"
              aria-label={`Dismiss ${item.title}`}
              onClick={() => dismissOne(item.id)}
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg3 hover:bg-hover"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
      {candidates.length > shown.length && (
        <button type="button" onClick={() => setExpanded(true)} className="px-3 py-1.5 text-left text-[13px] text-brand/80 hover:text-brand">
          Show {candidates.length - shown.length} more
        </button>
      )}
    </section>
  );
}

export function FocusCard() {
  const { data } = useFocusSessions();
  const session = useFocusStore((s) => s.session);
  const sessions = data ?? [];
  const todaySeconds = todayFocusedSeconds(sessions);
  const todayCount = sessionsToday(sessions).length;

  // Minutes per day for the last 7 days, today last.
  const week: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    week.push(
      sessions
        .filter((s) => {
          const t = new Date(s.started_at);
          return t >= d && t < next;
        })
        .reduce((sum, s) => sum + (s.actual_duration_seconds ?? 0), 0) / 60,
    );
  }
  const max = Math.max(30, ...week);

  return (
    <Panel elevated title="Focus" action="This week">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[28px] font-semibold leading-tight tracking-tight">{formatFocusDuration(todaySeconds)}</span>
          <span className="text-[13px] text-fg3">
            today · {todayCount} session{todayCount === 1 ? "" : "s"}
          </span>
        </div>
        <div aria-hidden="true" className="flex h-11 items-end gap-[5px]">
          {week.map((m, i) => (
            <span
              key={i}
              className={cn("w-2.5 rounded-[3px]", i === 6 ? "bg-foreground" : "bg-line2")}
              style={{ height: Math.max(4, (m / max) * 44) }}
            />
          ))}
        </div>
      </div>
      <Link
        to="/focus"
        className="flex h-10 items-center justify-center rounded-[10px] bg-sunken text-sm font-medium transition-colors hover:bg-hover"
      >
        {session ? "Back to your session" : "Start a session"}
      </Link>
    </Panel>
  );
}

export function NotesCard() {
  const { data: notes } = useQuickNotes();
  const createNote = useCreateQuickNote();
  const deleteNote = useDeleteQuickNote();
  const [text, setText] = useState("");

  return (
    <Panel elevated title="Notes">
      <textarea
        aria-label="Quick note"
        placeholder="Jot something down… (Enter to save)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!text.trim()) return;
            createNote.mutate({ body: text.trim() });
            setText("");
          }
        }}
        className="field-sizing-content min-h-14 resize-none rounded-[10px] bg-sunken px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-ring/40"
      />
      {notes && notes.length > 0 && (
        <ul className="-mt-1 flex flex-col text-[13.5px]">
          {notes.slice(0, 6).map((note, i) => (
            <li key={note.id} className={cn("group flex items-start justify-between gap-3 py-2", i > 0 && "border-t border-line")}>
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{note.body}</span>
              <span className="shrink-0 text-xs text-fg3 group-hover:hidden">
                {new Date(note.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
              <button
                type="button"
                aria-label="Delete note"
                onClick={() => deleteNote.mutate(note.id)}
                className="hidden shrink-0 text-fg3 hover:text-danger group-hover:block"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
