//! Public stand-in for the private `schedu-pro` crate.
//!
//! The free Schedu build compiles against this stub, so the public source and
//! the free installer contain none of the syllabus-reading code. Official Pro
//! builds replace this folder with the private crate (see docs/PRO-BUILD.md),
//! which exports exactly the same items.

mod types;
pub use types::*;

/// "free" here, "pro" in the private crate.
pub const EDITION: &str = "free";

pub fn is_pro_build() -> bool {
    false
}

pub fn extract(_req: &ExtractRequest, _bytes: &[u8]) -> Result<Extraction, ProError> {
    Err(ProError::Unavailable)
}

pub fn test_api_key(_api_key: &str, _model: &str) -> Result<(), ProError> {
    Err(ProError::Unavailable)
}

/// Rough cost of reading a file of this size, in US cents.
pub fn estimate_cost_cents(_file_name: &str, _len: usize, _model: &str) -> f64 {
    0.0
}

/// Seals the cached licence record so a hand-edited record is noticed. The
/// free build has nothing to protect, so this is a plain digest; the private
/// crate keys it with a secret that isn't in the public source.
pub fn seal(data: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    data.hash(&mut h);
    format!("{:016x}", h.finish())
}
