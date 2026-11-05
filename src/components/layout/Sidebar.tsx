import { useMemo, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { BarChart3, CalendarDays, CircleCheck, Plus, Search, SlidersHorizontal, Sun, Timer } from "lucide-react";
import { Dot, Kbd } from "@/components/lo/primitives";
import { ClassDialog } from "@/components/school/ClassDialog";
import { useContexts } from "@/hooks/useContexts";
import { useGoogleConnected, useItemSyncStatuses, useSyncConflicts } from "@/hooks/useGoogle";
import { useItems } from "@/hooks/useItems";
import { usePreferences } from "@/hooks/usePreferences";
import { activeClasses, PERSONAL_HEX, personalLists } from "@/lib/areas";
import { classColorHex } from "@/lib/classColors";
import { formatClock, remainingSeconds } from "@/lib/focusTiming";
import { cn } from "@/lib/utils";
import { useFocusStore } from "@/store/focusStore";
import { useSearchStore } from "@/store/searchStore";

const navItemClass = (active: boolean) =>
  cn(
    "flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0",
    active ? "bg-hover font-medium text-foreground" : "text-fg2 hover:bg-hover hover:text-foreground",
  );

const subItemClass = (active: boolean) =>
  cn(
    "flex h-[34px] items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors",
    active ? "bg-hover font-medium text-foreground" : "text-fg2 hover:bg-hover hover:text-foreground",
  );

function FocusBadge() {
  const session = useFocusStore((s) => s.session);
  useFocusStore((s) => s.tick);
  if (!session) return null;
  const remaining = remainingSeconds(session, new Date());
  return (
    <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] font-normal text-success">
      <span className={cn("size-1.5 rounded-full bg-success", session.running_since && "animate-pulse")} />
      {session.phase === "break" ? "Break" : remaining === null ? "Open" : formatClock(remaining)}
    </span>
  );
}

function SyncFooter() {
  const { data: connected } = useGoogleConnected();
  const { data: statuses } = useItemSyncStatuses(!!connected);
  const { data: conflicts } = useSyncConflicts();
  const issues = (statuses ?? []).filter((s) => s.status === "failed").length + (connected ? (conflicts?.length ?? 0) : 0);

  let tone = "bg-fg3";
  let label = "Google not connected";
  if (connected) {
    tone = issues > 0 ? "bg-danger" : "bg-success";
    label = issues > 0 ? `${issues} sync issue${issues === 1 ? "" : "s"}` : "Google sync on";
  }
  return (
    <Link to={connected ? "/" : "/settings?section=google"} className="flex items-center gap-2 px-2.5 pt-2 text-xs text-fg3 hover:text-fg2">
      <span className={cn("size-[7px] rounded-full", tone)} />
      {label}
    </Link>
  );
}

export function Sidebar() {
  const openSearch = useSearchStore((s) => s.open);
  const { data: contexts } = useContexts();
  const { data: items } = useItems();
  const { data: prefs } = usePreferences();
  const location = useLocation();
  const [classDialogOpen, setClassDialogOpen] = useState(false);

  const classes = activeClasses(contexts);
  const lists = useMemo(() => personalLists(items).filter((l) => l.open > 0), [items]);
  const openCount = (items ?? []).filter((i) => i.status !== "Completed").length;
  const params = new URLSearchParams(location.search);
  const onTasks = location.pathname === "/tasks";
  const activeList = onTasks ? params.get("list") : null;
  const activeArea = onTasks ? params.get("area") : null;
  const name = prefs?.user_name?.trim() || "Schedu";

  return (
    <aside className="flex w-[240px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-sidebar px-2.5 py-3.5">
      <div className="flex items-center gap-2.5 px-2.5 pb-3.5 pt-1.5">
        <div className="flex size-[26px] items-center justify-center rounded-lg bg-foreground">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="stroke-background">
            <circle cx="12" cy="12" r="8" strokeWidth="3" strokeDasharray="34 50" strokeLinecap="round" />
          </svg>
        </div>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-sm font-semibold">Schedu</span>
          <span className="truncate text-xs text-fg3">{name}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={() => openSearch()}
        className="mb-2.5 flex h-9 items-center gap-2.5 rounded-lg border border-line bg-card px-2.5 text-sm text-fg2 transition-colors hover:bg-hover"
      >
        <Search className="size-4 shrink-0" />
        <span className="flex-1 text-left">Search or add</span>
        <Kbd>Ctrl K</Kbd>
      </button>

      <NavLink to="/" end className={({ isActive }) => navItemClass(isActive)}>
        <Sun />
        Today
      </NavLink>
      <NavLink to="/tasks" className={() => navItemClass(onTasks && !activeList && !activeArea)}>
        <CircleCheck />
        <span className="flex-1">Tasks</span>
        {openCount > 0 && <span className="text-xs font-normal text-fg3">{openCount}</span>}
      </NavLink>
      <NavLink to="/calendar" className={({ isActive }) => navItemClass(isActive)}>
        <CalendarDays />
        Calendar
      </NavLink>
      <NavLink to="/focus" className={({ isActive }) => navItemClass(isActive)}>
        <Timer />
        Focus
        <FocusBadge />
      </NavLink>
      <NavLink to="/stats" className={({ isActive }) => navItemClass(isActive)}>
        <BarChart3 />
        Stats
      </NavLink>

      <div className="flex items-center justify-between px-2.5 pb-1.5 pt-5">
        <Link to="/tasks?area=School" className="lo-label hover:text-fg2">
          School
        </Link>
        <button
          type="button"
          aria-label="New class"
          onClick={() => setClassDialogOpen(true)}
          className="flex size-6 items-center justify-center rounded-md text-fg3 hover:bg-hover hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {classes.length === 0 ? (
        <button type="button" onClick={() => setClassDialogOpen(true)} className="px-2.5 py-1.5 text-left text-sm text-fg3 hover:text-fg2">
          Add your first class
        </button>
      ) : (
        classes.map((c) => (
          <NavLink key={c.id} to={`/school/${c.id}`} className={({ isActive }) => subItemClass(isActive)}>
            <Dot color={classColorHex(c.color)} />
            <span className="truncate">{c.name}</span>
          </NavLink>
        ))
      )}

      <div className="px-2.5 pb-1.5 pt-5">
        <Link to="/tasks?area=Personal" className={cn("lo-label hover:text-fg2", activeArea === "Personal" && "text-foreground")}>
          Personal
        </Link>
      </div>
      {lists.length === 0 ? (
        <p className="px-2.5 py-1 text-[13px] leading-snug text-fg3">
          Add <span className="font-mono text-xs">#list</span> to a task to make a list.
        </p>
      ) : (
        lists.map((l) => (
          <Link key={l.name} to={`/tasks?list=${encodeURIComponent(l.name)}`} className={subItemClass(activeList === l.name)}>
            <Dot color={PERSONAL_HEX} />
            <span className="flex-1 truncate">{l.name}</span>
            <span className="text-xs font-normal text-fg3">{l.open}</span>
          </Link>
        ))
      )}

      <div className="min-h-6 flex-1" />
      <NavLink to="/settings" className={({ isActive }) => navItemClass(isActive)}>
        <SlidersHorizontal />
        Settings
      </NavLink>
      <SyncFooter />

      <ClassDialog open={classDialogOpen} onOpenChange={setClassDialogOpen} />
    </aside>
  );
}
