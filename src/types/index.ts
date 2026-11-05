export type ContextType = "Class" | "Project" | "Program";
export type ContextStatus = "Active" | "Archived";

export interface Context {
  id: string;
  type: ContextType;
  name: string;
  color: string | null;
  status: ContextStatus;
  term: string | null;
  schedule: string | null;
  owner: string | null;
  grade_scale: Record<string, number> | null;
  grade_cutoffs: Record<string, number> | null;
}

export interface ContextInput {
  type: ContextType;
  name: string;
  color?: string | null;
  status?: ContextStatus;
  term?: string | null;
  schedule?: string | null;
  owner?: string | null;
  grade_scale?: Record<string, number> | null;
  grade_cutoffs?: Record<string, number> | null;
}

/** Stored categories. The UI groups everything into two areas — School and
 * Personal — and treats any legacy category (Work, Gym, Finance…) as a
 * Personal list of the same name; see lib/areas.ts. */
export type Category =
  | "School"
  | "Work"
  | "Gym"
  | "Personal"
  | "Finance"
  | "Projects"
  | "Relationships"
  | "Health"
  | "Travel"
  | "Custom";

export type Priority = "Low" | "Medium" | "High";
export type ItemStatus = "Not Started" | "In Progress" | "Completed";

export interface Item {
  id: string;
  title: string;
  description: string | null;
  category: Category;
  subcategory_id: string | null;
  subcategory_text: string | null;
  due_date: string | null;
  due_time: string | null;
  estimated_duration: number | null;
  priority: Priority;
  status: ItemStatus;
  repeat_settings: string | null;
  color: string | null;
  notes: string | null;
  tags: string[] | null;
  attachments: string[] | null;
  location: string | null;

  google_calendar_id: string | null;
  google_task_id: string | null;
  last_synced_at_calendar: string | null;
  last_synced_at_tasks: string | null;
  last_sync_error: string | null;
  last_sync_attempted_at: string | null;
  sync_failure_count: number;

  assignment_type: string | null;
  points_earned: number | null;
  points_possible: number | null;

  obsidian_source_id: string | null;
  obsidian_vault_path: string | null;
  obsidian_source_folder: string | null;
  obsidian_source_file: string | null;
  obsidian_source_section: string | null;

  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface QuickNote {
  id: string;
  body: string;
  created_at: string;
}

export interface QuickNoteInput {
  body: string;
}

export interface Note {
  id: string;
  context_id: string;
  item_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface NoteInput {
  context_id: string;
  item_id?: string | null;
  body: string;
}

export interface GoogleEventDateTime {
  date: string | null;
  dateTime: string | null;
}

export interface GoogleCalendarEvent {
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  updated: string | null;
  status: string | null;
  start: GoogleEventDateTime | null;
  end: GoogleEventDateTime | null;
  /** Google's per-event color override (fixed "1".."11" event palette id), null when the event just uses its calendar's default color. */
  color_id: string | null;
}

export interface GoogleCalendarListEntry {
  id: string;
  summary: string | null;
  background_color: string | null;
  primary: boolean | null;
}

export interface GoogleTask {
  id: string;
  title: string | null;
  notes: string | null;
  updated: string | null;
  status: string | null;
  due: string | null;
  deleted: boolean | null;
}

/** Mirrors google/sync.rs's SyncSnapshot — one field per app-supported sync
 * field. `null`/absent on a remote snapshot means that source (Calendar or
 * Tasks) has no concept of that field, not that its value happens to match. */
export interface SyncSnapshot {
  title?: string | null;
  notes?: string | null;
  due_date?: string | null;
  due_time?: string | null;
  status?: string | null;
  priority?: string | null;
  estimated_duration?: number | null;
  location?: string | null;
}

export interface SyncSnapshotFieldDiff {
  field: string;
  local: string;
  remote: string;
}

export interface SyncConflict {
  id: string;
  item_id: string;
  source: "calendar" | "tasks";
  local_snapshot: SyncSnapshot;
  remote_snapshot: SyncSnapshot;
  diff: SyncSnapshotFieldDiff[];
  created_at: string;
}

export type ItemSyncStatusValue = "synced" | "pending" | "failed" | "conflict";

export interface ItemSyncStatus {
  item_id: string;
  status: ItemSyncStatusValue;
  last_sync_error: string | null;
}

export interface RemoteBackupStatus {
  written_at: string;
}

export interface ObsidianNote {
  path: string;
  title: string;
  snippet: string | null;
  modified: string | null;
}

export interface ObsidianVaultStatus {
  valid: boolean;
  note_count: number;
  error: string | null;
}

export interface ObsidianScanSummary {
  vault_path: string | null;
  scan_folder: string;
  scanned_at: string;
  files_scanned: number;
  actionable_sections_found: number;
  tasks_found: number;
  new_tasks: number;
  existing_tasks: number;
  completed_source_tasks: number;
  errors: string[];
  error: string | null;
}

export interface ItemInput {
  title: string;
  description?: string | null;
  category: Category;
  subcategory_id?: string | null;
  subcategory_text?: string | null;
  due_date?: string | null;
  due_time?: string | null;
  estimated_duration?: number | null;
  priority?: Priority;
  status?: ItemStatus;
  repeat_settings?: string | null;
  color?: string | null;
  notes?: string | null;
  tags?: string[] | null;
  attachments?: string[] | null;
  location?: string | null;
  assignment_type?: string | null;
  points_earned?: number | null;
  points_possible?: number | null;
}

export type FocusPhase = "focus" | "break";
export type FocusSessionState = "active" | "closed";
export type FocusOutcome = "completed" | "partial" | "not_completed" | "interrupted";

export interface FocusSession {
  id: string;
  intent: string;
  goal: string | null;
  item_id: string | null;
  category: string | null;
  planned_duration_seconds: number | null;
  break_duration_seconds: number;
  phase: FocusPhase;
  running_since: string | null;
  accumulated_seconds: number;
  started_at: string;
  ended_at: string | null;
  actual_duration_seconds: number | null;
  session_state: FocusSessionState;
  outcome: FocusOutcome | null;
  reflection_note: string | null;
  created_at: string;
}

export interface StartFocusSessionInput {
  intent: string;
  goal?: string | null;
  item_id?: string | null;
  category?: string | null;
  planned_duration_seconds?: number | null;
  break_duration_seconds: number;
}
