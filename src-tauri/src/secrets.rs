//! Secrets kept in the operating system's credential store, never in the
//! SQLite database: the Schedu Pro licence key and activation record, and the
//! user's Anthropic API key. Keeping them out of the database keeps them out
//! of backups, which copy that file to a folder the user picks (often a cloud
//! folder).
//!
//! On Windows they're written to Credential Manager with "local machine"
//! persistence, so they stay on this PC only. (The default "enterprise"
//! persistence, which the keyring crate hard-codes, lets credentials roam to
//! the user's other PCs on networks with roaming profiles, such as school
//! domains.)

const SERVICE: &str = "app.schedu.desktop";

pub const LICENSE_KEY: &str = "pro-license-key";
pub const ACTIVATION: &str = "pro-activation";
pub const AI_KEY: &str = "anthropic-api-key";
pub const DEVICE_ID: &str = "pro-device-id";

/// The demo profile (SCHEDU_DEMO=1) gets its own entries so screenshots never
/// show, use or overwrite the real licence or API key.
fn service() -> String {
    if crate::demo::enabled() {
        format!("{SERVICE}.demo")
    } else {
        SERVICE.to_string()
    }
}

#[cfg(windows)]
mod store {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND, FILETIME};
    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn get(target: &str) -> Result<Option<String>, String> {
        let target = wide(target);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: target is NUL-terminated; on success Windows allocates the
        // credential, which is read once and then released with CredFree.
        unsafe {
            if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) == 0 {
                let err = GetLastError();
                return if err == ERROR_NOT_FOUND { Ok(None) } else { Err(format!("error {err}")) };
            }
            let c = &*cred;
            let blob = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec();
            CredFree(cred as *const _);
            String::from_utf8(blob).map(Some).map_err(|e| e.to_string())
        }
    }

    pub fn set(target: &str, user: &str, value: &str) -> Result<(), String> {
        let mut target_w = wide(target);
        let mut user_w = wide(user);
        let mut blob = value.as_bytes().to_vec();
        // SAFETY: every pointer refers to a buffer that outlives the call.
        unsafe {
            let mut cred: CREDENTIALW = std::mem::zeroed();
            cred.Type = CRED_TYPE_GENERIC;
            cred.TargetName = target_w.as_mut_ptr();
            cred.UserName = user_w.as_mut_ptr();
            cred.CredentialBlobSize = blob.len() as u32;
            cred.CredentialBlob = blob.as_mut_ptr();
            cred.Persist = CRED_PERSIST_LOCAL_MACHINE;
            cred.LastWritten = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let ok = CredWriteW(&cred, 0);
            blob.iter_mut().for_each(|b| *b = 0);
            if ok == 0 {
                return Err(format!("error {}", GetLastError()));
            }
        }
        Ok(())
    }

    pub fn remove(target: &str) -> Result<(), String> {
        let target = wide(target);
        // SAFETY: target is NUL-terminated.
        unsafe {
            if CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) == 0 {
                let err = GetLastError();
                if err != ERROR_NOT_FOUND {
                    return Err(format!("error {err}"));
                }
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod store {
    // Schedu ships for Windows only; this keeps other platforms compiling.
    fn entry(target: &str) -> Result<keyring::Entry, String> {
        let (service, user) = target.split_once('/').unwrap_or((target, ""));
        keyring::Entry::new(service, user).map_err(|e| e.to_string())
    }
    pub fn get(target: &str) -> Result<Option<String>, String> {
        match entry(target)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    pub fn set(target: &str, _user: &str, value: &str) -> Result<(), String> {
        entry(target)?.set_password(value).map_err(|e| e.to_string())
    }
    pub fn remove(target: &str) -> Result<(), String> {
        match entry(target)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

fn target(name: &str) -> String {
    format!("{}/{name}", service())
}

pub fn get(name: &str) -> Result<Option<String>, String> {
    store::get(&target(name)).map_err(|e| format!("Couldn't read from Windows Credential Manager ({e})."))
}

pub fn set(name: &str, value: &str) -> Result<(), String> {
    store::set(&target(name), name, value).map_err(|e| format!("Couldn't save to Windows Credential Manager ({e})."))
}

pub fn remove(name: &str) -> Result<(), String> {
    store::remove(&target(name)).map_err(|e| format!("Couldn't remove from Windows Credential Manager ({e})."))
}

#[cfg(all(test, windows))]
mod tests {
    use super::store;

    #[test]
    fn round_trips_and_removes_a_local_credential() {
        let target = format!("app.schedu.desktop.test/{}", uuid::Uuid::new_v4());
        assert_eq!(store::get(&target).unwrap(), None);
        store::set(&target, "test", "sk-ant-secret-ünïcode").unwrap();
        assert_eq!(store::get(&target).unwrap().as_deref(), Some("sk-ant-secret-ünïcode"));
        store::remove(&target).unwrap();
        assert_eq!(store::get(&target).unwrap(), None);
        store::remove(&target).unwrap(); // removing twice is fine
    }
}
