// Shared between the public stub (Schedu/src-tauri/pro) and the private
// schedu-pro crate. Keep the two copies byte-for-byte identical: the app is
// compiled against whichever one sits in src-tauri/pro, so any drift breaks
// the Pro build. `scripts/pro-build.ps1` checks this before building.

use serde::{Deserialize, Serialize};

/// What the app knows about the class an import is for. Passed in so the
/// reader can fill in missing years from the term and match assignment types
/// to the class's existing grade categories.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassContext {
    pub class_name: String,
    /// Free text from the class, e.g. "Winter 2027". May be empty.
    pub term: Option<String>,
    /// Today's date (YYYY-MM-DD), used only to pick a year when neither the
    /// syllabus nor the class says which year a date falls in.
    pub today: String,
    /// The class's current grade-weight categories (keys of grade_scale).
    pub grade_categories: Vec<String>,
    /// Items already in this class, so re-imports can be flagged as duplicates.
    pub existing_items: Vec<ExistingItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExistingItem {
    pub id: String,
    pub title: String,
    pub due_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractRequest {
    pub file_name: String,
    pub api_key: String,
    pub model: String,
    pub context: ClassContext,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GradeWeight {
    pub category: String,
    pub weight_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DateRange {
    pub label: String,
    /// YYYY-MM-DD
    pub start: String,
    /// YYYY-MM-DD
    pub end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CourseInfo {
    pub course_code: Option<String>,
    pub course_title: Option<String>,
    pub instructor: Option<String>,
    pub term_label: Option<String>,
    /// YYYY-MM-DD, from the syllabus if stated, else from the class's term.
    pub term_start: Option<String>,
    pub term_end: Option<String>,
    /// Reading weeks, holidays and other breaks named in the syllabus.
    pub breaks: Vec<DateRange>,
    pub grade_weights: Vec<GradeWeight>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Flag {
    /// The syllabus gives no date for this item.
    MissingDate,
    /// Only a week number is given ("Week 6"); left undated on purpose.
    WeekOnly,
    /// The year wasn't written, so it was filled in from the term.
    YearInferred,
    /// The date falls outside the term.
    OutsideTerm,
    /// The date falls in a reading week or other break.
    DuringBreak,
    /// Looks the same as an item already in the class or in this import.
    Duplicate,
    /// No matching grade category in the class.
    CategoryUnmatched,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Candidate {
    pub title: String,
    /// assignment, exam, quiz, project, lab, presentation, reading, participation, other
    pub kind: String,
    /// YYYY-MM-DD. None when the syllabus gives no full date (see flags).
    pub due_date: Option<String>,
    /// HH:MM, 24-hour.
    pub due_time: Option<String>,
    pub week: Option<u32>,
    pub weight_percent: Option<f64>,
    /// Best match among the class's grade categories, else the syllabus's own
    /// category name.
    pub grade_category: Option<String>,
    /// The words in the syllabus this row came from, shown on the review
    /// screen so every row can be checked against the source.
    pub source_text: String,
    pub notes: Option<String>,
    pub flags: Vec<Flag>,
    /// Set when `Duplicate` matched an item already in the class.
    pub duplicate_of: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Rough cost in US cents on the user's own Anthropic account.
    pub estimated_cost_cents: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Extraction {
    pub model: String,
    pub course: CourseInfo,
    pub candidates: Vec<Candidate>,
    pub usage: Usage,
}

/// Every failure the app needs to explain in plain words. `message()` gives
/// the text shown to the user.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum ProError {
    /// This is the free build; the Pro code isn't in it.
    Unavailable,
    InvalidKey,
    NoCredit,
    ModelUnavailable(String),
    RateLimited,
    Overloaded,
    FileTooLarge,
    UnsupportedFile(String),
    EmptyFile,
    Refused,
    Truncated,
    Network(String),
    Api(String),
    Parse(String),
}

impl ProError {
    pub fn message(&self) -> String {
        match self {
            ProError::Unavailable => "Syllabus import is part of Schedu Pro.".into(),
            ProError::InvalidKey => {
                "Anthropic didn't accept your API key. Check it in Settings → Schedu Pro.".into()
            }
            ProError::NoCredit => {
                "Your Anthropic account is out of credit. Add credit in the Anthropic Console, then try again.".into()
            }
            ProError::ModelUnavailable(m) => {
                format!("Your Anthropic account can't use {m}. Pick the other model in Settings → Schedu Pro.")
            }
            ProError::RateLimited => {
                "Anthropic is limiting requests on your account right now. Wait a minute and try again.".into()
            }
            ProError::Overloaded => "Anthropic is busy right now. Try again in a few minutes.".into(),
            ProError::FileTooLarge => "That file is too large. Syllabus files up to 20 MB are supported.".into(),
            ProError::UnsupportedFile(name) => {
                format!("{name} isn't a PDF, Word (.docx) or text file.")
            }
            ProError::EmptyFile => "No text could be read from that file.".into(),
            ProError::Refused => "The file couldn't be read as a syllabus.".into(),
            ProError::Truncated => {
                "The syllabus was too long to read in one go. Try a shorter file, or split it.".into()
            }
            ProError::Network(e) => format!("Couldn't reach Anthropic: {e}"),
            ProError::Api(e) => format!("Anthropic returned an error: {e}"),
            ProError::Parse(e) => format!("Couldn't understand the reply: {e}"),
        }
    }
}

impl std::fmt::Display for ProError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for ProError {}
