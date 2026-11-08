//! Syllabus import: storing what was read, approving it into the planner,
//! and undoing an import. The reading itself happens in the Pro crate; this
//! side only ever writes rows the user approved on the review screen.

use crate::commands::{insert_item_row, now, row_to_item, touch_activity, update_item_row, ITEM_COLUMNS};
use crate::db::{DbPathState, DbState};
use crate::google::sync::SyncTrigger;
use crate::license;
use crate::models::Item;
use crate::pro::{DEFAULT_MODEL, MODEL_PREF_KEY};
use crate::secrets;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use schedu_pro::{Candidate, ClassContext, CourseInfo, ExistingItem, ExtractRequest, Usage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Serialize, Clone)]
pub struct CandidateRow {
    pub id: String,
    pub position: i64,
    pub candidate: Candidate,
    pub decision: Option<String>,
    pub item_id: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct IntakeBatch {
    pub id: String,
    pub context_id: String,
    pub file_name: String,
    pub model: String,
    pub status: String,
    pub course: CourseInfo,
    pub usage: Usage,
    pub created_at: String,
    pub committed_at: Option<String>,
    pub undone_at: Option<String>,
    pub candidates: Vec<CandidateRow>,
}

#[derive(Debug, Serialize, Clone)]
pub struct IntakeSummary {
    pub id: String,
    pub file_name: String,
    pub status: String,
    pub created_at: String,
    pub committed_at: Option<String>,
    pub added: i64,
    pub merged: i64,
}

/// What the user decided for one row on the review screen.
#[derive(Debug, Deserialize)]
pub struct Decision {
    pub candidate_id: String,
    /// "add", "merge" (update the matching item already in the class) or "skip".
    pub action: String,
    pub title: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub assignment_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ApplyCourse {
    pub instructor: bool,
    pub grade_weights: bool,
}

#[derive(Debug, Serialize)]
pub struct CommitResult {
    pub added: usize,
    pub merged: usize,
    pub skipped: usize,
    /// Rows skipped because the same item was already imported before.
    pub already_imported: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct PreviousContext {
    owner: Option<String>,
    grade_scale: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct PreviousItemFields {
    title: String,
    due_date: Option<String>,
    due_time: Option<String>,
    assignment_type: Option<String>,
}

fn load_batch(conn: &Connection, id: &str) -> Result<IntakeBatch, String> {
    let mut batch = conn
        .query_row(
            "SELECT id, context_id, file_name, model, status, course_json, usage_json, created_at, committed_at, undone_at \
             FROM intake_batch WHERE id = ?1",
            params![id],
            |r| {
                let course: String = r.get(5)?;
                let usage: String = r.get(6)?;
                Ok(IntakeBatch {
                    id: r.get(0)?,
                    context_id: r.get(1)?,
                    file_name: r.get(2)?,
                    model: r.get(3)?,
                    status: r.get(4)?,
                    course: serde_json::from_str(&course).unwrap_or_else(|_| empty_course()),
                    usage: serde_json::from_str(&usage).unwrap_or_default(),
                    created_at: r.get(7)?,
                    committed_at: r.get(8)?,
                    undone_at: r.get(9)?,
                    candidates: vec![],
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("That import no longer exists.")?;
    let mut stmt = conn
        .prepare("SELECT id, position, data_json, decision, item_id FROM intake_candidate WHERE batch_id = ?1 ORDER BY position")
        .map_err(|e| e.to_string())?;
    batch.candidates = stmt
        .query_map(params![id], |r| {
            let data: String = r.get(2)?;
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, data, r.get(3)?, r.get(4)?))
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter_map(|(id, position, data, decision, item_id)| {
            serde_json::from_str(&data).ok().map(|candidate| CandidateRow { id, position, candidate, decision, item_id })
        })
        .collect();
    Ok(batch)
}

fn empty_course() -> CourseInfo {
    CourseInfo {
        course_code: None,
        course_title: None,
        instructor: None,
        term_label: None,
        term_start: None,
        term_end: None,
        breaks: vec![],
        grade_weights: vec![],
    }
}

fn class_context(conn: &Connection, context_id: &str) -> Result<ClassContext, String> {
    let (name, term, grade_scale): (String, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT name, term, grade_scale FROM context WHERE id = ?1 AND type = 'Class'",
            params![context_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("That class no longer exists.")?;
    let grade_categories = grade_scale
        .and_then(|s| serde_json::from_str::<BTreeMap<String, f64>>(&s).ok())
        .map(|m| m.into_keys().collect())
        .unwrap_or_default();
    let mut stmt = conn
        .prepare("SELECT id, title, due_date FROM item WHERE subcategory_id = ?1 AND deleted_at IS NULL")
        .map_err(|e| e.to_string())?;
    let existing_items = stmt
        .query_map(params![context_id], |r| Ok(ExistingItem { id: r.get(0)?, title: r.get(1)?, due_date: r.get(2)? }))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(ClassContext {
        class_name: name,
        term,
        today: chrono::Local::now().format("%Y-%m-%d").to_string(),
        grade_categories,
        existing_items,
    })
}

fn get_pref(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM preference WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
}

/// Reads a syllabus with the user's own Anthropic key and stores the rows for
/// review. Nothing is added to the planner until `intake_commit`.
#[tauri::command]
pub async fn intake_extract(
    state: State<'_, DbPathState>,
    context_id: String,
    file_name: String,
    file_base64: String,
) -> Result<IntakeBatch, String> {
    if !schedu_pro::is_pro_build() {
        return Err(schedu_pro::ProError::Unavailable.message());
    }
    let db_path = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !license::ensure_unlocked() {
            return Err("Schedu Pro isn't active on this computer. Check Settings → Schedu Pro.".to_string());
        }
        let api_key = secrets::get(secrets::AI_KEY)?
            .ok_or("Add your Anthropic API key in Settings → Schedu Pro first.")?;
        let bytes = B64.decode(file_base64.as_bytes()).map_err(|_| "That file couldn't be read.".to_string())?;

        let conn = crate::db::init(&db_path).map_err(|e| e.to_string())?;
        let context = class_context(&conn, &context_id)?;
        let model = get_pref(&conn, MODEL_PREF_KEY).unwrap_or_else(|| DEFAULT_MODEL.to_string());
        // The network call can take a minute; don't hold the database meanwhile.
        drop(conn);

        let request = ExtractRequest { file_name: file_name.clone(), api_key, model, context };
        let extraction = schedu_pro::extract(&request, &bytes).map_err(|e| e.message())?;

        let conn = crate::db::init(&db_path).map_err(|e| e.to_string())?;
        let batch_id = Uuid::new_v4().to_string();
        let file_sha = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO intake_batch (id, context_id, file_name, file_sha256, model, status, course_json, usage_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'review', ?6, ?7, ?8)",
            params![
                batch_id,
                context_id,
                file_name,
                file_sha,
                extraction.model,
                serde_json::to_string(&extraction.course).map_err(|e| e.to_string())?,
                serde_json::to_string(&extraction.usage).map_err(|e| e.to_string())?,
                now(),
            ],
        )
        .map_err(|e| e.to_string())?;
        for (i, c) in extraction.candidates.iter().enumerate() {
            tx.execute(
                "INSERT INTO intake_candidate (id, batch_id, position, data_json) VALUES (?1, ?2, ?3, ?4)",
                params![Uuid::new_v4().to_string(), batch_id, i as i64, serde_json::to_string(c).map_err(|e| e.to_string())?],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        load_batch(&conn, &batch_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn intake_get(state: State<DbState>, batch_id: String) -> Result<IntakeBatch, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    load_batch(&conn, &batch_id)
}

#[tauri::command]
pub fn intake_list(state: State<DbState>, context_id: String) -> Result<Vec<IntakeSummary>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.file_name, b.status, b.created_at, b.committed_at, \
               (SELECT COUNT(*) FROM intake_candidate c WHERE c.batch_id = b.id AND c.decision = 'added'), \
               (SELECT COUNT(*) FROM intake_candidate c WHERE c.batch_id = b.id AND c.decision = 'merged') \
             FROM intake_batch b WHERE b.context_id = ?1 AND b.status != 'discarded' ORDER BY b.created_at DESC LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![context_id], |r| {
            Ok(IntakeSummary {
                id: r.get(0)?,
                file_name: r.get(1)?,
                status: r.get(2)?,
                created_at: r.get(3)?,
                committed_at: r.get(4)?,
                added: r.get(5)?,
                merged: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

/// Same class + same title + same date always gives the same id, so importing
/// the same syllabus twice can't create the item twice.
fn source_id(context_id: &str, title: &str, due_date: Option<&str>) -> String {
    let norm: String = title
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    let digest = Sha256::digest(format!("{context_id}|{norm}|{}", due_date.unwrap_or("")).as_bytes());
    digest.iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn valid_date(d: &Option<String>) -> Option<String> {
    d.as_deref()
        .map(str::trim)
        .filter(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok())
        .map(str::to_string)
}

fn valid_time(t: &Option<String>) -> Option<String> {
    t.as_deref()
        .map(str::trim)
        .filter(|s| chrono::NaiveTime::parse_from_str(s, "%H:%M").is_ok())
        .map(str::to_string)
}

fn non_empty(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn new_school_item(context_id: &str, d: &Decision, candidate: &Candidate) -> Item {
    let timestamp = now();
    let mut notes = format!("From the syllabus: “{}”", candidate.source_text);
    if let Some(n) = &candidate.notes {
        notes = format!("{n}\n\n{notes}");
    }
    Item {
        id: Uuid::new_v4().to_string(),
        title: d.title.trim().to_string(),
        description: None,
        category: "School".into(),
        subcategory_id: Some(context_id.to_string()),
        subcategory_text: None,
        due_date: valid_date(&d.due_date),
        due_time: valid_date(&d.due_date).and(valid_time(&d.due_time)),
        estimated_duration: None,
        priority: "Medium".into(),
        status: "Not Started".into(),
        repeat_settings: None,
        color: None,
        notes: Some(notes),
        tags: None,
        attachments: None,
        location: None,
        google_calendar_id: None,
        google_task_id: None,
        last_synced_at_calendar: None,
        last_synced_at_tasks: None,
        last_sync_error: None,
        last_sync_attempted_at: None,
        sync_failure_count: 0,
        assignment_type: non_empty(&d.assignment_type),
        points_earned: None,
        points_possible: None,
        obsidian_source_id: None,
        obsidian_vault_path: None,
        obsidian_source_folder: None,
        obsidian_source_file: None,
        obsidian_source_section: None,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        deleted_at: None,
    }
}

fn load_item(conn: &Connection, id: &str) -> rusqlite::Result<Option<Item>> {
    conn.query_row(
        &format!("SELECT {ITEM_COLUMNS} FROM item WHERE id = ?1 AND deleted_at IS NULL"),
        params![id],
        row_to_item,
    )
    .optional()
}

/// Writes every approved row in one transaction, so an import is all or
/// nothing.
pub fn commit_batch(conn: &Connection, batch_id: &str, decisions: &[Decision], apply: &ApplyCourse) -> Result<CommitResult, String> {
    let batch = load_batch(conn, batch_id)?;
    if batch.status != "review" {
        return Err("This import was already saved or discarded.".into());
    }
    let by_id: BTreeMap<&str, &CandidateRow> = batch.candidates.iter().map(|c| (c.id.as_str(), c)).collect();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut result = CommitResult { added: 0, merged: 0, skipped: 0, already_imported: 0 };

    // Class details first, remembering what they were for undo.
    let (owner, grade_scale): (Option<String>, Option<String>) = tx
        .query_row("SELECT owner, grade_scale FROM context WHERE id = ?1", params![batch.context_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    let previous = PreviousContext { owner: owner.clone(), grade_scale: grade_scale.clone() };
    let mut new_owner = owner;
    let mut new_scale = grade_scale;
    if apply.instructor {
        if let Some(instructor) = batch.course.instructor.clone() {
            new_owner = Some(instructor);
        }
    }
    if apply.grade_weights && !batch.course.grade_weights.is_empty() {
        let scale: BTreeMap<&str, f64> =
            batch.course.grade_weights.iter().map(|w| (w.category.as_str(), w.weight_percent)).collect();
        new_scale = Some(serde_json::to_string(&scale).map_err(|e| e.to_string())?);
    }
    tx.execute(
        "UPDATE context SET owner = ?2, grade_scale = ?3 WHERE id = ?1",
        params![batch.context_id, new_owner, new_scale],
    )
    .map_err(|e| e.to_string())?;

    for d in decisions {
        let row = by_id.get(d.candidate_id.as_str()).ok_or("A row on the review screen didn't match this import.")?;
        let title_empty = d.title.trim().is_empty();
        let (decision, item_id, previous_fields): (&str, Option<String>, Option<String>) = match d.action.as_str() {
            "add" if !title_empty => {
                let due = valid_date(&d.due_date);
                let sid = source_id(&batch.context_id, &d.title, due.as_deref());
                let exists: bool = tx
                    .prepare("SELECT 1 FROM item WHERE intake_source_id = ?1 AND deleted_at IS NULL")
                    .and_then(|mut s| s.exists(params![sid]))
                    .map_err(|e| e.to_string())?;
                if exists {
                    result.already_imported += 1;
                    ("skipped", None, None)
                } else {
                    let item = new_school_item(&batch.context_id, d, &row.candidate);
                    insert_item_row(&tx, &item).map_err(|e| e.to_string())?;
                    tx.execute(
                        "UPDATE item SET intake_source_id = ?2, intake_batch_id = ?3 WHERE id = ?1",
                        params![item.id, sid, batch_id],
                    )
                    .map_err(|e| e.to_string())?;
                    result.added += 1;
                    ("added", Some(item.id), None)
                }
            }
            "merge" if !title_empty => {
                let target = row.candidate.duplicate_of.as_deref().ok_or("Only rows that match an existing item can be merged.")?;
                match load_item(&tx, target).map_err(|e| e.to_string())? {
                    Some(mut item) => {
                        let before = PreviousItemFields {
                            title: item.title.clone(),
                            due_date: item.due_date.clone(),
                            due_time: item.due_time.clone(),
                            assignment_type: item.assignment_type.clone(),
                        };
                        item.title = d.title.trim().to_string();
                        if let Some(due) = valid_date(&d.due_date) {
                            item.due_date = Some(due);
                            item.due_time = valid_time(&d.due_time).or(item.due_time);
                        }
                        if let Some(t) = non_empty(&d.assignment_type) {
                            item.assignment_type = Some(t);
                        }
                        item.updated_at = now();
                        update_item_row(&tx, &item).map_err(|e| e.to_string())?;
                        result.merged += 1;
                        ("merged", Some(item.id), Some(serde_json::to_string(&before).map_err(|e| e.to_string())?))
                    }
                    None => {
                        result.skipped += 1;
                        ("skipped", None, None)
                    }
                }
            }
            _ => {
                result.skipped += 1;
                ("skipped", None, None)
            }
        };
        tx.execute(
            "UPDATE intake_candidate SET decision = ?2, item_id = ?3, merged_previous_json = ?4 WHERE id = ?1",
            params![d.candidate_id, decision, item_id, previous_fields],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.execute(
        "UPDATE intake_batch SET status = 'committed', committed_at = ?2, previous_context_json = ?3 WHERE id = ?1",
        params![batch_id, now(), serde_json::to_string(&previous).map_err(|e| e.to_string())?],
    )
    .map_err(|e| e.to_string())?;
    touch_activity(&tx);
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

/// Takes an import back out: removes the items it added (Google sync then
/// deletes their events), restores the fields it changed on existing items,
/// and puts the class's instructor and grade weights back.
pub fn undo_batch(conn: &Connection, batch_id: &str) -> Result<(), String> {
    let status: String = conn
        .query_row("SELECT status FROM intake_batch WHERE id = ?1", params![batch_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("That import no longer exists.")?;
    if status != "committed" {
        return Err("Only a saved import can be undone.".into());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let timestamp = now();
    tx.execute(
        "UPDATE item SET deleted_at = ?2, updated_at = ?2 WHERE intake_batch_id = ?1 AND deleted_at IS NULL",
        params![batch_id, timestamp],
    )
    .map_err(|e| e.to_string())?;

    let merged: Vec<(String, String)> = {
        let mut stmt = tx
            .prepare("SELECT item_id, merged_previous_json FROM intake_candidate WHERE batch_id = ?1 AND decision = 'merged'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![batch_id], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter_map(|(a, b)| Some((a?, b?)))
            .collect();
        rows
    };
    for (item_id, previous) in merged {
        let Ok(before) = serde_json::from_str::<PreviousItemFields>(&previous) else { continue };
        if let Some(mut item) = load_item(&tx, &item_id).map_err(|e| e.to_string())? {
            item.title = before.title;
            item.due_date = before.due_date;
            item.due_time = before.due_time;
            item.assignment_type = before.assignment_type;
            item.updated_at = timestamp.clone();
            update_item_row(&tx, &item).map_err(|e| e.to_string())?;
        }
    }

    let previous_context: Option<String> = tx
        .query_row("SELECT previous_context_json FROM intake_batch WHERE id = ?1", params![batch_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if let Some(prev) = previous_context.and_then(|p| serde_json::from_str::<PreviousContext>(&p).ok()) {
        tx.execute(
            "UPDATE context SET owner = ?2, grade_scale = ?3 WHERE id = (SELECT context_id FROM intake_batch WHERE id = ?1)",
            params![batch_id, prev.owner, prev.grade_scale],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE intake_batch SET status = 'undone', undone_at = ?2 WHERE id = ?1",
        params![batch_id, timestamp],
    )
    .map_err(|e| e.to_string())?;
    touch_activity(&tx);
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn intake_commit(
    state: State<DbState>,
    trigger: State<SyncTrigger>,
    batch_id: String,
    decisions: Vec<Decision>,
    apply: ApplyCourse,
) -> Result<CommitResult, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    let result = commit_batch(&conn, &batch_id, &decisions, &apply)?;
    drop(conn);
    trigger.notify();
    Ok(result)
}

#[tauri::command]
pub fn intake_undo(state: State<DbState>, trigger: State<SyncTrigger>, batch_id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    undo_batch(&conn, &batch_id)?;
    drop(conn);
    trigger.notify();
    Ok(())
}

#[tauri::command]
pub fn intake_discard(state: State<DbState>, batch_id: String) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE intake_batch SET status = 'discarded' WHERE id = ?1 AND status = 'review'",
        params![batch_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use schedu_pro::{Flag, GradeWeight};

    fn setup() -> (Connection, String) {
        let dir = std::env::temp_dir().join(format!("schedu-intake-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::init(&dir.join("t.sqlite3")).unwrap();
        conn.execute(
            "INSERT INTO context (id, type, name, status, owner, grade_scale) VALUES ('c1', 'Class', 'BUS 201', 'Active', NULL, '{\"Exams\":60}')",
            [],
        )
        .unwrap();
        let existing = Item { id: "old".into(), title: "Midterm".into(), due_date: Some("2027-02-20".into()), ..new_school_item("c1", &dec("x", "add", "Midterm", None), &cand("Midterm", None, None)) };
        insert_item_row(&conn, &existing).unwrap();

        let course = CourseInfo {
            instructor: Some("Dr. Lee".into()),
            grade_weights: vec![GradeWeight { category: "Exams".into(), weight_percent: 50.0 }, GradeWeight { category: "Quizzes".into(), weight_percent: 50.0 }],
            ..empty_course()
        };
        conn.execute(
            "INSERT INTO intake_batch (id, context_id, file_name, file_sha256, model, status, course_json, usage_json, created_at) \
             VALUES ('b1', 'c1', 's.pdf', 'x', 'm', 'review', ?1, '{}', ?2)",
            params![serde_json::to_string(&course).unwrap(), now()],
        )
        .unwrap();
        let rows = [
            cand("Quiz 1", Some("2027-01-20"), None),
            cand("Midterm", Some("2027-02-25"), Some("old")),
            cand("Participation", None, None),
        ];
        for (i, c) in rows.iter().enumerate() {
            conn.execute(
                "INSERT INTO intake_candidate (id, batch_id, position, data_json) VALUES (?1, 'b1', ?2, ?3)",
                params![format!("k{i}"), i as i64, serde_json::to_string(c).unwrap()],
            )
            .unwrap();
        }
        (conn, "b1".into())
    }

    fn cand(title: &str, due: Option<&str>, duplicate_of: Option<&str>) -> Candidate {
        Candidate {
            title: title.into(),
            kind: "quiz".into(),
            due_date: due.map(str::to_string),
            due_time: None,
            week: None,
            weight_percent: None,
            grade_category: None,
            source_text: format!("{title} – source"),
            notes: None,
            flags: if duplicate_of.is_some() { vec![Flag::Duplicate] } else { vec![] },
            duplicate_of: duplicate_of.map(str::to_string),
        }
    }

    fn dec(id: &str, action: &str, title: &str, due: Option<&str>) -> Decision {
        Decision {
            candidate_id: id.into(),
            action: action.into(),
            title: title.into(),
            due_date: due.map(str::to_string),
            due_time: Some("23:59".into()),
            assignment_type: Some("Quizzes".into()),
        }
    }

    fn count_live(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM item WHERE deleted_at IS NULL AND subcategory_id = 'c1'", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn commit_then_undo_restores_everything() {
        let (conn, batch) = setup();
        let decisions = vec![
            dec("k0", "add", "Quiz 1", Some("2027-01-20")),
            dec("k1", "merge", "Midterm", Some("2027-02-25")),
            dec("k2", "skip", "Participation", None),
        ];
        let result = commit_batch(&conn, &batch, &decisions, &ApplyCourse { instructor: true, grade_weights: true }).unwrap();
        assert_eq!((result.added, result.merged, result.skipped), (1, 1, 1));
        assert_eq!(count_live(&conn), 2);
        let (owner, scale): (Option<String>, String) =
            conn.query_row("SELECT owner, grade_scale FROM context WHERE id='c1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(owner.as_deref(), Some("Dr. Lee"));
        assert!(scale.contains("Quizzes"));
        let moved: String = conn.query_row("SELECT due_date FROM item WHERE id='old'", [], |r| r.get(0)).unwrap();
        assert_eq!(moved, "2027-02-25");
        let added_notes: String = conn
            .query_row("SELECT notes FROM item WHERE title='Quiz 1'", [], |r| r.get(0))
            .unwrap();
        assert!(added_notes.contains("From the syllabus"));

        // Saving twice is refused.
        assert!(commit_batch(&conn, &batch, &decisions, &ApplyCourse { instructor: false, grade_weights: false }).is_err());

        undo_batch(&conn, &batch).unwrap();
        assert_eq!(count_live(&conn), 1);
        let back: String = conn.query_row("SELECT due_date FROM item WHERE id='old'", [], |r| r.get(0)).unwrap();
        assert_eq!(back, "2027-02-20");
        let (owner, scale): (Option<String>, String) =
            conn.query_row("SELECT owner, grade_scale FROM context WHERE id='c1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(owner, None);
        assert_eq!(scale, "{\"Exams\":60}");
        assert!(undo_batch(&conn, &batch).is_err(), "undo only once");
    }

    #[test]
    fn reimporting_the_same_item_is_skipped() {
        let (conn, batch) = setup();
        commit_batch(&conn, &batch, &[dec("k0", "add", "Quiz 1", Some("2027-01-20"))], &ApplyCourse { instructor: false, grade_weights: false }).unwrap();
        conn.execute("UPDATE intake_batch SET status = 'review' WHERE id = 'b1'", []).unwrap();
        let again = commit_batch(&conn, &batch, &[dec("k0", "add", "quiz 1!", Some("2027-01-20"))], &ApplyCourse { instructor: false, grade_weights: false }).unwrap();
        assert_eq!((again.added, again.already_imported), (0, 1));
    }

    #[test]
    fn bad_dates_and_times_are_dropped_not_saved() {
        let (conn, batch) = setup();
        let mut d = dec("k2", "add", "Participation", Some("next week"));
        d.due_time = Some("noon".into());
        commit_batch(&conn, &batch, &[d], &ApplyCourse { instructor: false, grade_weights: false }).unwrap();
        let (due, time): (Option<String>, Option<String>) = conn
            .query_row("SELECT due_date, due_time FROM item WHERE title='Participation'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((due, time), (None, None));
    }
}
