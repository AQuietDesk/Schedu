import { invoke } from "@tauri-apps/api/core";
import type {
  Context,
  ContextInput,
  FocusOutcome,
  FocusSession,
  GoogleCalendarEvent,
  GoogleCalendarListEntry,
  GoogleTask,
  Item,
  ItemInput,
  ItemSyncStatus,
  Note,
  NoteInput,
  ObsidianNote,
  ObsidianScanSummary,
  ObsidianVaultStatus,
  QuickNote,
  QuickNoteInput,
  RemoteBackupStatus,
  StartFocusSessionInput,
  SyncConflict,
} from "@/types";

export const commands = {
  createItem: (input: ItemInput) => invoke<Item>("create_item", { input }),
  updateItem: (item: Item) => invoke<Item>("update_item", { item }),
  softDeleteItem: (id: string) => invoke<void>("soft_delete_item", { id }),
  listItems: () => invoke<Item[]>("list_items"),

  createContext: (input: ContextInput) => invoke<Context>("create_context", { input }),
  updateContext: (context: Context) => invoke<Context>("update_context", { context }),
  listContexts: () => invoke<Context[]>("list_contexts"),

  createQuickNote: (input: QuickNoteInput) => invoke<QuickNote>("create_quick_note", { input }),
  listQuickNotes: () => invoke<QuickNote[]>("list_quick_notes"),
  deleteQuickNote: (id: string) => invoke<void>("delete_quick_note", { id }),

  createNote: (input: NoteInput) => invoke<Note>("create_note", { input }),
  listNotesForContext: (contextId: string) =>
    invoke<Note[]>("list_notes_for_context", { contextId }),
  deleteNote: (id: string) => invoke<void>("delete_note", { id }),

  getPreference: (key: string) => invoke<string | null>("get_preference", { key }),
  setPreference: (key: string, value: string) => invoke<void>("set_preference", { key, value }),
  listPreferences: () => invoke<[string, string][]>("list_preferences"),

  startFocusSession: (input: StartFocusSessionInput) =>
    invoke<FocusSession>("start_focus_session", { input }),
  getActiveFocusSession: () => invoke<FocusSession | null>("get_active_focus_session"),
  pauseFocusSession: (id: string) => invoke<FocusSession>("pause_focus_session", { id }),
  resumeFocusSession: (id: string) => invoke<FocusSession>("resume_focus_session", { id }),
  completeFocusPhase: (id: string) => invoke<FocusSession>("complete_focus_phase", { id }),
  submitReflection: (id: string, outcome: FocusOutcome, note: string | null) =>
    invoke<FocusSession>("submit_reflection", { id, outcome, note }),
  endBreak: (id: string) => invoke<FocusSession>("end_break", { id }),
  abandonFocusSession: (id: string) => invoke<FocusSession>("abandon_focus_session", { id }),
  listFocusSessions: () => invoke<FocusSession[]>("list_focus_sessions"),
  deleteFocusSession: (id: string) => invoke<void>("delete_focus_session", { id }),

  isGoogleConnected: () => invoke<boolean>("is_google_connected"),
  connectGoogle: () => invoke<void>("connect_google"),
  disconnectGoogle: () => invoke<void>("disconnect_google"),
  syncNow: () => invoke<void>("sync_now"),
  pushItemNow: (itemId: string) => invoke<void>("push_item_now", { itemId }),
  listItemSyncStatuses: () => invoke<ItemSyncStatus[]>("list_item_sync_statuses"),
  listSyncConflicts: () => invoke<SyncConflict[]>("list_sync_conflicts"),
  resolveConflict: (id: string, resolution: "mine" | "google" | "dismiss") =>
    invoke<void>("resolve_conflict", { id, resolution }),
  listUpcomingCalendarEvents: () => invoke<GoogleCalendarEvent[]>("list_upcoming_calendar_events"),
  listUpcomingGoogleTasks: () => invoke<GoogleTask[]>("list_upcoming_google_tasks"),
  listCalendarEventsInRange: (calendarId: string, timeMin: string, timeMax: string) =>
    invoke<GoogleCalendarEvent[]>("list_calendar_events_in_range", { calendarId, timeMin, timeMax }),
  listCalendars: () => invoke<GoogleCalendarListEntry[]>("list_calendars"),

  backupNow: () => invoke<void>("backup_now"),
  checkRemoteBackup: () => invoke<RemoteBackupStatus | null>("check_remote_backup"),
  dismissRemoteBackup: (writtenAt: string) =>
    invoke<void>("dismiss_remote_backup", { writtenAt }),
  restoreFromBackup: (writtenAt: string) => invoke<void>("restore_from_backup", { writtenAt }),

  isAutostartEnabled: () => invoke<boolean>("is_autostart_enabled"),
  enableAutostart: () => invoke<void>("enable_autostart"),
  disableAutostart: () => invoke<void>("disable_autostart"),

  notifyNow: (title: string, body: string) => invoke<void>("notify_now", { title, body }),

  searchObsidianVault: (query: string) => invoke<ObsidianNote[]>("search_obsidian_vault", { query }),
  readObsidianNote: (relativePath: string) =>
    invoke<string>("read_obsidian_note", { relativePath }),
  testObsidianVault: (path: string) => invoke<ObsidianVaultStatus>("test_obsidian_vault", { path }),
  scanObsidianTasks: () => invoke<ObsidianScanSummary>("scan_obsidian_tasks"),
};
