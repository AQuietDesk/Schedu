import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Dot, PrimaryButton, Segmented, SecondaryButton, TopBar } from "@/components/lo/primitives";
import { ClassDialog } from "@/components/school/ClassDialog";
import { Switch } from "@/components/ui/switch";
import { useAutostartEnabled, useSetAutostart } from "@/hooks/useAutostart";
import { useContexts, useUpdateContext } from "@/hooks/useContexts";
import { useCalendarList, useConnectGoogle, useDisconnectGoogle, useGoogleConnected, useSyncNow } from "@/hooks/useGoogle";
import { useScanObsidianTasks, useTestObsidianVault } from "@/hooks/useObsidianVault";
import { GradeScaleEditor } from "@/components/school/GradeScaleEditor";
import { useBackupNow, useGradeScale, usePreferences, useSetPreference, useSyncFromBackup } from "@/hooks/usePreferences";
import { DEFAULT_GRADE_SCALE, GRADE_SCALE_PREF_KEY, PLUS_MINUS_GRADE_SCALE, type GradeBand } from "@/lib/gradeScale";
import { useUpcomingNotificationSettings } from "@/hooks/useUpcomingNotifications";
import { useTheme } from "@/hooks/useTheme";
import { classColorHex } from "@/lib/classColors";
import { DEFAULT_SLEEP_BEDTIME, DEFAULT_SLEEP_WAKE, SLEEP_BEDTIME_PREF_KEY, SLEEP_WAKE_PREF_KEY } from "@/lib/dayRing";
import { parseSelectedCalendarIds, SELECTED_CALENDARS_PREF_KEY } from "@/lib/googleCalendarSelection";
import { NOTIFICATION_DEFAULTS, WEEKDAY_LABELS } from "@/lib/notificationDefaults";
import { NOTIFICATION_WINDOW_OPTIONS, type NotificationWindowDays } from "@/lib/notificationEngine";
import { cn } from "@/lib/utils";
import { Group, SettingRow } from "@/components/settings/SettingsAtoms";
import { ProSettings } from "@/components/pro/ProSettings";
import type { Context } from "@/types";
import type { Theme } from "@/store/themeStore";

type Section = "general" | "school" | "pro" | "google" | "notifications" | "obsidian" | "backup";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "school", label: "School" },
  { id: "pro", label: "Schedu Pro" },
  { id: "google", label: "Google" },
  { id: "notifications", label: "Notifications" },
  { id: "obsidian", label: "Obsidian" },
  { id: "backup", label: "Backup" },
];

type PrefKey = keyof typeof NOTIFICATION_DEFAULTS;

function usePref() {
  const { data: prefs } = usePreferences();
  const setPreference = useSetPreference();
  const get = (key: PrefKey) => prefs?.[key] ?? NOTIFICATION_DEFAULTS[key];
  const set = (key: string, value: string) => setPreference.mutate({ key, value });
  return { prefs, get, set };
}

// ---- layout atoms --------------------------------------------------------

const inlineInput =
  "h-8 rounded-lg border border-transparent bg-transparent px-2 text-right text-[14.5px] text-fg2 outline-none hover:bg-hover focus:border-line2 focus:bg-card focus:text-foreground";
const pill = "h-8 rounded-lg bg-sunken px-2.5 text-sm outline-none focus:ring-2 focus:ring-ring/40";

/** Text pref that saves on blur. */
function TextPref({ id, prefKey, placeholder, width = "w-56", align = "right" }: { id?: string; prefKey: PrefKey; placeholder?: string; width?: string; align?: "right" | "left" }) {
  const { get, set } = usePref();
  const [local, setLocal] = useState<string | null>(null);
  const value = local ?? get(prefKey);
  return (
    <input
      id={id}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local !== null) set(prefKey, local);
        setLocal(null);
      }}
      className={cn(inlineInput, width, align === "left" && "text-left")}
    />
  );
}

function BoolPref({ prefKey, label }: { prefKey: PrefKey; label: string }) {
  const { get, set } = usePref();
  return <Switch aria-label={label} checked={get(prefKey) === "true"} onCheckedChange={(c) => set(prefKey, String(c))} />;
}

// ---- sections ------------------------------------------------------------

function ClassesGroup() {
  const { data: contexts } = useContexts();
  const updateContext = useUpdateContext();
  const [editing, setEditing] = useState<Context | undefined>();
  const [creating, setCreating] = useState(false);
  const classes = (contexts ?? []).filter((c) => c.type === "Class").sort((a, b) => Number(a.status === "Archived") - Number(b.status === "Archived") || a.name.localeCompare(b.name));

  return (
    <Group title="Classes" footer="Archived classes leave the sidebar but keep their assignments and grades.">
      {classes.map((c) => (
        <div key={c.id} className="flex min-h-[52px] items-center gap-3 px-4">
          <Dot color={classColorHex(c.color)} />
          <span className={cn("min-w-0 flex-1 truncate text-[14.5px]", c.status === "Archived" && "text-fg3")}>
            {c.name}
            {c.term && <span className="text-fg3"> · {c.term}</span>}
          </span>
          <button type="button" onClick={() => setEditing(c)} className="h-8 rounded-lg px-2.5 text-[13px] text-fg2 hover:bg-hover">
            Edit
          </button>
          <button
            type="button"
            onClick={() => updateContext.mutate({ ...c, status: c.status === "Active" ? "Archived" : "Active" })}
            className="h-8 rounded-lg px-2.5 text-[13px] text-fg2 hover:bg-hover"
          >
            {c.status === "Active" ? "Archive" : "Restore"}
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setCreating(true)} className="flex min-h-[48px] items-center px-4 text-left text-[14.5px] text-brand hover:bg-hover">
        Add class…
      </button>
      <ClassDialog open={!!editing} onOpenChange={(o) => !o && setEditing(undefined)} context={editing} />
      <ClassDialog open={creating} onOpenChange={setCreating} />
    </Group>
  );
}

function General() {
  const { theme, setTheme } = useTheme();
  const { prefs, set } = usePref();
  const { data: autostart, isLoading } = useAutostartEnabled();
  const setAutostart = useSetAutostart();

  return (
    <>
      <Group title="Appearance">
        <SettingRow label="Theme" description="System follows your Windows light/dark setting.">
          <Segmented<Theme>
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "System" },
            ]}
          />
        </SettingRow>
      </Group>

      <Group title="You">
        <SettingRow label="Name" description="Used in Today’s greeting." htmlFor="pref-name">
          <TextPref id="pref-name" prefKey="user_name" />
        </SettingRow>
        <SettingRow label="Weather location" description="City and province, looked up with Open-Meteo." htmlFor="pref-weather">
          <TextPref id="pref-weather" prefKey="weather_location" />
        </SettingRow>
      </Group>

      <Group title="Day ring" footer="Sleep anchors the 24-hour ring on Today.">
        <SettingRow label="Wake up" htmlFor="pref-wake">
          <input
            id="pref-wake"
            type="time"
            value={prefs?.[SLEEP_WAKE_PREF_KEY] ?? DEFAULT_SLEEP_WAKE}
            onChange={(e) => e.target.value && set(SLEEP_WAKE_PREF_KEY, e.target.value)}
            className={pill}
          />
        </SettingRow>
        <SettingRow label="Bedtime" htmlFor="pref-bed">
          <input
            id="pref-bed"
            type="time"
            value={prefs?.[SLEEP_BEDTIME_PREF_KEY] ?? DEFAULT_SLEEP_BEDTIME}
            onChange={(e) => e.target.value && set(SLEEP_BEDTIME_PREF_KEY, e.target.value)}
            className={pill}
          />
        </SettingRow>
      </Group>

      <ClassesGroup />

      <Group title="Startup" footer={setAutostart.isError ? <span className="text-danger">{String(setAutostart.error)}</span> : undefined}>
        <SettingRow label="Start with Windows" description="Opens quietly to the tray so reminders still fire.">
          <Switch
            aria-label="Start with Windows"
            checked={!!autostart}
            disabled={isLoading || setAutostart.isPending}
            onCheckedChange={(c) => setAutostart.mutate(c)}
          />
        </SettingRow>
      </Group>
    </>
  );
}

function School() {
  const saved = useGradeScale();
  const { set } = usePref();
  const [draft, setDraft] = useState<GradeBand[] | null>(null);
  const bands = draft ?? saved;
  const valid = bands.length > 0 && bands.every((b) => b.letter.trim());

  return (
    <Group
      title="Grade scale"
      footer="Your school's letters, the lowest percent for each, and GPA points. Classes use this unless you set a custom scale in the class's Edit dialog."
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        <GradeScaleEditor value={bands} onChange={setDraft} />
        <div className="flex gap-2">
          <PrimaryButton
            disabled={!draft || !valid}
            onClick={() => {
              set(GRADE_SCALE_PREF_KEY, JSON.stringify(bands.map((b) => ({ ...b, letter: b.letter.trim() }))));
              setDraft(null);
            }}
          >
            Save
          </PrimaryButton>
          <SecondaryButton onClick={() => setDraft(PLUS_MINUS_GRADE_SCALE)}>Standard +/-</SecondaryButton>
          <SecondaryButton onClick={() => setDraft(DEFAULT_GRADE_SCALE)}>Reset to default</SecondaryButton>
        </div>
      </div>
    </Group>
  );
}

function Google() {
  const { data: connected, isLoading } = useGoogleConnected();
  const connectGoogle = useConnectGoogle();
  const disconnectGoogle = useDisconnectGoogle();
  const syncNow = useSyncNow();
  const { data: calendars } = useCalendarList(!!connected);
  const { prefs, set } = usePref();
  const selectedIds = useMemo(() => parseSelectedCalendarIds(prefs?.[SELECTED_CALENDARS_PREF_KEY]), [prefs]);

  const error = connectGoogle.isError
    ? String(connectGoogle.error)
    : syncNow.isError
      ? String(syncNow.error).includes("GOOGLE_RECONNECT_REQUIRED")
        ? "Your Google connection expired. Reconnect to resume sync."
        : String(syncNow.error)
      : null;

  return (
    <>
      <Group
        title="Account"
        footer={error ? <span className="text-danger">{error}</span> : "Sign-in happens in your browser. Schedu only gets a Calendar and Tasks token, never your password. While Google reviews Schedu, it may say the app isn't verified: choose Advanced, then Go to Schedu."}
      >
        <SettingRow
          label={
            <>
              Google Calendar & Tasks
              <span className="ml-2 rounded-md bg-brand-soft px-1.5 py-0.5 align-middle text-[11px] font-medium text-brand">Beta</span>
            </>
          }
          description={isLoading ? "Checking…" : connected ? "Connected" : "Not connected"}>
          {connected ? (
            <>
              <SecondaryButton onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
                {syncNow.isPending ? "Syncing…" : "Sync now"}
              </SecondaryButton>
              <SecondaryButton onClick={() => disconnectGoogle.mutate()} disabled={disconnectGoogle.isPending}>
                Disconnect
              </SecondaryButton>
            </>
          ) : (
            <PrimaryButton onClick={() => connectGoogle.mutate()} disabled={connectGoogle.isPending}>
              {connectGoogle.isPending ? "Waiting for sign-in…" : "Connect"}
            </PrimaryButton>
          )}
        </SettingRow>
        <SettingRow label="Full sync every" description="Edits push within about a second either way." htmlFor="pref-sync">
          <TextPref id="pref-sync" prefKey="sync_interval_minutes" width="w-16" />
          <span className="text-sm text-fg3">min</span>
        </SettingRow>
      </Group>

      {connected && calendars && calendars.length > 0 && (
        <Group title="Calendars shown" footer="These appear on the Calendar page and the Day ring alongside your primary calendar.">
          {calendars.map((cal) => {
            const checked = !!cal.primary || selectedIds.includes(cal.id);
            return (
              <label key={cal.id} className="flex min-h-[48px] items-center gap-3 px-4 text-[14.5px]">
                <Dot color={cal.background_color ?? "#8e8e8a"} square={false} />
                <span className="min-w-0 flex-1 truncate">
                  {cal.summary ?? cal.id}
                  {cal.primary && <span className="text-fg3"> · primary</span>}
                </span>
                <Switch
                  aria-label={cal.summary ?? cal.id}
                  checked={checked}
                  disabled={!!cal.primary}
                  onCheckedChange={() => {
                    const next = selectedIds.includes(cal.id) ? selectedIds.filter((x) => x !== cal.id) : [...selectedIds, cal.id];
                    set(SELECTED_CALENDARS_PREF_KEY, JSON.stringify(next));
                  }}
                />
              </label>
            );
          })}
        </Group>
      )}
    </>
  );
}

function Notifications() {
  const { get, set } = usePref();
  const { settings, setWindowDays, setPriorityOverrideEnabled, setRepeatDailyEnabled } = useUpcomingNotificationSettings();

  return (
    <>
      <Group title="Windows notifications">
        <SettingRow label="Morning briefing" description="What’s due today.">
          <input type="time" aria-label="Morning briefing time" value={get("morning_briefing_time")} onChange={(e) => set("morning_briefing_time", e.target.value)} className={pill} />
          <BoolPref prefKey="morning_briefing_enabled" label="Morning briefing" />
        </SettingRow>
        <SettingRow label="Evening review" description="A nudge to plan tomorrow.">
          <input type="time" aria-label="Evening review time" value={get("evening_review_time")} onChange={(e) => set("evening_review_time", e.target.value)} className={pill} />
          <BoolPref prefKey="evening_review_enabled" label="Evening review" />
        </SettingRow>
        <SettingRow label="Weekly planning">
          <select aria-label="Weekly planning day" value={get("weekly_planning_day")} onChange={(e) => set("weekly_planning_day", e.target.value)} className={pill}>
            {WEEKDAY_LABELS.map((label, i) => (
              <option key={label} value={String(i)}>
                {label}
              </option>
            ))}
          </select>
          <input type="time" aria-label="Weekly planning time" value={get("weekly_planning_time")} onChange={(e) => set("weekly_planning_time", e.target.value)} className={pill} />
          <BoolPref prefKey="weekly_planning_enabled" label="Weekly planning" />
        </SettingRow>
        <SettingRow label="Before a deadline">
          <input
            type="number"
            min={1}
            aria-label="Hours before deadline"
            value={get("upcoming_deadline_lead_hours")}
            onChange={(e) => set("upcoming_deadline_lead_hours", e.target.value)}
            className={cn(pill, "w-16")}
          />
          <span className="text-sm text-fg3">hours</span>
          <BoolPref prefKey="upcoming_deadline_enabled" label="Before a deadline" />
        </SettingRow>
        <SettingRow label="When something becomes overdue">
          <BoolPref prefKey="overdue_enabled" label="Overdue" />
        </SettingRow>
      </Group>

      <Group title="On Today" footer="The “coming up” card at the top of Today. Each task shows once a day until you dismiss it.">
        <SettingRow label="Look ahead">
          <select
            aria-label="Look ahead"
            value={String(settings.windowDays)}
            onChange={(e) => setWindowDays(Number(e.target.value) as NotificationWindowDays)}
            className={pill}
          >
            {NOTIFICATION_WINDOW_OPTIONS.map((opt) => (
              <option key={opt.value} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="High priority shows earlier">
          <Switch aria-label="High priority shows earlier" checked={settings.priorityOverrideEnabled} onCheckedChange={setPriorityOverrideEnabled} />
        </SettingRow>
        <SettingRow label="Repeat high priority daily">
          <Switch aria-label="Repeat high priority daily" checked={settings.repeatDailyEnabled} onCheckedChange={setRepeatDailyEnabled} />
        </SettingRow>
      </Group>
    </>
  );
}

function Obsidian() {
  const { prefs, get } = usePref();
  const testVault = useTestObsidianVault();
  const scanTasks = useScanObsidianTasks();
  const vaultPath = get("obsidian_vault_path");
  const lastScanAt = prefs?.["obsidian_scan_last_at"];
  const summary = useMemo(() => {
    try {
      return JSON.parse(prefs?.["obsidian_scan_last_summary"] ?? "null") as {
        files_scanned: number;
        tasks_found: number;
        new_tasks: number;
        completed_source_tasks: number;
        errors: string[];
        error: string | null;
      } | null;
    } catch {
      return null;
    }
  }, [prefs]);

  return (
    <>
      <Group
        title="Vault"
        footer={
          testVault.data ? (
            <span className={testVault.data.valid ? undefined : "text-danger"}>
              {testVault.data.valid ? `Found ${testVault.data.note_count} notes.` : testVault.data.error}
            </span>
          ) : (
            "Notes from your vault show up in Ctrl K search."
          )
        }
      >
        <SettingRow label="Vault folder" htmlFor="pref-vault">
          <TextPref id="pref-vault" prefKey="obsidian_vault_path" placeholder="C:\Users\you\Documents\Vault" width="w-72" align="left" />
          <SecondaryButton onClick={() => testVault.mutate(vaultPath)} disabled={testVault.isPending || !vaultPath.trim()}>
            {testVault.isPending ? "Checking…" : "Test"}
          </SecondaryButton>
        </SettingRow>
      </Group>

      <Group
        title="Task scanner"
        footer="Imports unchecked “- [ ]” items under “## Next Steps” and “## Action Items” headings into a Personal list called Obsidian. Re-scans never duplicate, and ticking a box in Obsidian completes the task here."
      >
        <SettingRow label="Folder to scan" description="Relative to the vault." htmlFor="pref-scan">
          <TextPref id="pref-scan" prefKey="obsidian_scan_folder" width="w-44" />
        </SettingRow>
        <SettingRow
          label="Scan now"
          description={
            scanTasks.isError ? (
              <span className="text-danger">{String(scanTasks.error)}</span>
            ) : summary?.error ? (
              <span className="text-danger">{summary.error}</span>
            ) : summary && lastScanAt ? (
              `${new Date(lastScanAt).toLocaleString()} · ${summary.files_scanned} files · ${summary.new_tasks} new · ${summary.completed_source_tasks} completed${summary.errors.length ? ` · ${summary.errors.length} errors` : ""}`
            ) : (
              "Never scanned"
            )
          }
        >
          <SecondaryButton onClick={() => scanTasks.mutate()} disabled={scanTasks.isPending || !vaultPath.trim()}>
            {scanTasks.isPending ? "Scanning…" : "Scan"}
          </SecondaryButton>
        </SettingRow>
      </Group>
    </>
  );
}

function Backup() {
  const { prefs, get } = usePref();
  const backupNow = useBackupNow();
  const syncFromBackup = useSyncFromBackup();
  const [message, setMessage] = useState<string | null>(null);
  const folder = get("backup_folder_path");
  const lastBackupAt = prefs?.["last_backup_at"];

  return (
    <Group
      title="Backup"
      footer={
        backupNow.isError || syncFromBackup.isError ? (
          <span className="text-danger">{String(backupNow.error ?? syncFromBackup.error)}</span>
        ) : (
          message ??
          "Everything lives in one local file. Point this at a Drive, Dropbox or OneDrive folder and a snapshot is saved about 5 minutes after you stop editing (and daily). Another device pointed at the same folder will offer to load it."
        )
      }
    >
      <SettingRow label="Backup folder" htmlFor="pref-backup">
        <TextPref id="pref-backup" prefKey="backup_folder_path" placeholder="C:\Users\you\Google Drive\Schedu" width="w-80" align="left" />
      </SettingRow>
      <SettingRow label="Last backup" description={lastBackupAt ? new Date(lastBackupAt).toLocaleString() : "None yet"}>
        <SecondaryButton onClick={() => backupNow.mutate()} disabled={backupNow.isPending || !folder.trim()}>
          {backupNow.isPending ? "Backing up…" : "Back up now"}
        </SecondaryButton>
        <SecondaryButton
          disabled={syncFromBackup.isPending || !folder.trim()}
          onClick={() => {
            setMessage(null);
            syncFromBackup.mutate(undefined, { onSuccess: (r) => !r.synced && setMessage("Already up to date — no newer backup in that folder.") });
          }}
        >
          {syncFromBackup.isPending ? "Checking…" : "Load newer"}
        </SecondaryButton>
      </SettingRow>
    </Group>
  );
}

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const section = (SECTIONS.find((s) => s.id === params.get("section"))?.id ?? "general") as Section;

  return (
    <div className="flex min-h-full flex-col">
      <TopBar>Settings</TopBar>
      <div className="flex flex-wrap items-start">
        <nav aria-label="Settings sections" className="flex w-full flex-col gap-0.5 px-4 pb-4 pt-10 sm:w-[230px] sm:pl-7">
          <h1 className="mb-4 ml-2.5 text-[28px] font-semibold tracking-[-0.02em]">Settings</h1>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setParams(s.id === "general" ? {} : { section: s.id }, { replace: true })}
              className={cn(
                "flex h-9 items-center justify-between rounded-lg px-2.5 text-left text-sm",
                section === s.id ? "bg-hover font-medium" : "text-fg2 hover:bg-hover",
              )}
            >
              {s.label}
              {section === s.id && <ChevronRight className="size-3.5 text-fg3" />}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 max-w-[720px] flex-[999_1_480px] flex-col gap-7 px-6 pb-14 sm:pt-[104px]">
          {section === "general" && <General />}
          {section === "school" && <School />}
          {section === "pro" && <ProSettings />}
          {section === "google" && <Google />}
          {section === "notifications" && <Notifications />}
          {section === "obsidian" && <Obsidian />}
          {section === "backup" && <Backup />}
          <p className="ml-1 text-[12.5px] text-fg3">Schedu {__APP_VERSION__}</p>
        </div>
      </div>
    </div>
  );
}
