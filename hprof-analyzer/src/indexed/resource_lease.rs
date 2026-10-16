//! Cooperative cross-process admission, held for the lifetime of analysis data.
//! OS file locks release after crashes. Records contain only reserved byte counts.
use super::{resource_plan::Plan, resource_probe::Limits};
use anyhow::{ensure, Context, Result};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Debug, thiserror::Error)]
#[error("Analysis needs an estimated {required_mib} MiB, but {available_mib} MiB is available in the HeapLens resource budget. Close other dump editors/applications or use disk mode. No automatic memory-mode fallback was started.")]
pub struct ResourceError {
    pub required_mib: u64,
    pub available_mib: u64,
}

#[derive(Debug)]
pub(crate) struct Lease {
    _file: tempfile::NamedTempFile,
}
const MIB: u64 = 1024 * 1024;
impl Lease {
    pub fn acquire(plan: Plan) -> Result<Arc<Self>> {
        let root = match super::storage::StorageOptions::default().directory() {
            Ok(default) => default
                .parent()
                .context("Missing resource directory")?
                .join("resources-v1"),
            Err(_) => fallback_root()?,
        };
        Self::in_directory(plan, &root, super::resource_probe::read()?)
    }
    fn in_directory(plan: Plan, root: &Path, limits: Limits) -> Result<Arc<Self>> {
        limits.validate()?;
        ensure!(root.is_absolute(), "Resource directory must be absolute");
        private(root)?;
        let coordinator = root.join("coordinator");
        if coordinator.exists() {
            check_file(&coordinator)?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let gate = options.open(coordinator)?;
        let start = std::time::Instant::now();
        loop {
            match gate.try_lock() {
                Ok(()) => break,
                Err(std::fs::TryLockError::WouldBlock) if start.elapsed().as_secs() < 5 => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                Err(error) => anyhow::bail!("Resource coordinator lock failed: {error}"),
            }
        }
        let mut reserved = 0u64;
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            if !entry.file_name().to_string_lossy().starts_with("lease-") {
                continue;
            }
            if let Err(error) = check_file(&entry.path()) {
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                {
                    continue;
                }
                return Err(error);
            }
            let mut file = match OpenOptions::new().read(true).write(true).open(entry.path()) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            match file.try_lock() {
                Ok(()) => {
                    // Stale lease from a terminated process, not a user artifact.
                    drop(file);
                    if let Err(error) = std::fs::remove_file(entry.path()) {
                        if error.kind() != std::io::ErrorKind::NotFound {
                            return Err(error.into());
                        }
                    }
                }
                Err(std::fs::TryLockError::WouldBlock) => {
                    ensure!(
                        file.metadata()?.len() == 8,
                        "Invalid active resource reservation"
                    );
                    let mut bytes = [0; 8];
                    file.read_exact(&mut bytes)?;
                    reserved = reserved
                        .checked_add(u64::from_le_bytes(bytes))
                        .context("Resource reservation overflow")?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        // Leave 25% of physical/container capacity to the host and OS. Current
        // availability is a second gate; active reservations are not credited
        // back just because some of their pages have not been touched yet.
        let ceiling = limits.total - limits.total / 4;
        let headroom = limits.available - limits.available / 10;
        let available = ceiling.saturating_sub(reserved).min(headroom);
        if plan.bytes > available {
            return Err(ResourceError {
                required_mib: plan.bytes.div_ceil(MIB),
                available_mib: available / MIB,
            }
            .into());
        }
        let mut file = tempfile::Builder::new()
            .prefix("lease-")
            .tempfile_in(root)?;
        file.as_file().lock()?;
        file.write_all(&plan.bytes.to_le_bytes())?;
        file.flush()?;
        log::info!("Resource admission: estimated {} MiB; {} MiB budget headroom (cooperative estimate, not an RSS limit)",
            plan.bytes.div_ceil(MIB), available / MIB);
        // Gate drops only after the new locked, complete lease is visible.
        Ok(Arc::new(Self { _file: file }))
    }
}
#[cfg(unix)]
fn fallback_root() -> Result<PathBuf> {
    unsafe extern "C" {
        fn geteuid() -> u32;
    }
    // Headless services need not have HOME. Keep shared /tmp namespaces
    // distinct per effective user; the directory is still checked as private.
    Ok(std::env::temp_dir().join(format!("HeapLens-resources-v1-{}", unsafe { geteuid() })))
}
#[cfg(windows)]
fn fallback_root() -> Result<PathBuf> {
    // Do not fall back to a potentially shared Windows system temp directory.
    Ok(PathBuf::from(
        std::env::var_os("USERPROFILE")
            .context("A private user profile is required for resource admission")?,
    )
    .join("AppData/Local/HeapLens/resources-v1"))
}
#[cfg(not(any(unix, windows)))]
fn fallback_root() -> Result<PathBuf> {
    anyhow::bail!("A private resource directory is required")
}
fn private(path: &Path) -> Result<()> {
    let mut directory = std::fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(path)?;
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "Resource directory must be real and private"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "Resource directory must have permissions 0700"
        );
    }
    Ok(())
}
fn check_file(path: &PathBuf) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "Invalid resource reservation file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "Resource reservation must be private"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        root
    }
    #[test]
    fn leases_account_for_retained_states_reject_overcommit_and_release_on_drop() {
        let root = root();
        let limits = Limits {
            total: 1000,
            available: 1000,
        };
        let one = Lease::in_directory(Plan { bytes: 400 }, root.path(), limits).unwrap();
        let retained = one.clone();
        drop(one);
        assert!(Lease::in_directory(Plan { bytes: 400 }, root.path(), limits).is_err());
        drop(retained);
        Lease::in_directory(Plan { bytes: 700 }, root.path(), limits).unwrap();
        assert!(Lease::in_directory(Plan { bytes: 901 }, root.path(), limits).is_err());
    }
    #[test]
    fn stale_leases_are_recovered_but_invalid_active_records_fail_closed() {
        let root = root();
        let mut stale = tempfile::Builder::new()
            .prefix("lease-")
            .tempfile_in(root.path())
            .unwrap();
        stale.write_all(b"abandoned").unwrap();
        let (_, path) = stale.keep().unwrap();
        Lease::in_directory(
            Plan { bytes: 1 },
            root.path(),
            Limits {
                total: 1000,
                available: 1000,
            },
        )
        .unwrap();
        assert!(!path.exists());
        let active = tempfile::Builder::new()
            .prefix("lease-")
            .tempfile_in(root.path())
            .unwrap();
        active.as_file().lock().unwrap();
        assert!(Lease::in_directory(
            Plan { bytes: 1 },
            root.path(),
            Limits {
                total: 1000,
                available: 1000
            }
        )
        .is_err());
    }
    #[test]
    fn child_reservation_holder() {
        let Some(root) = std::env::var_os("HEAPLENS_RESOURCE_TEST_ROOT") else {
            return;
        };
        let _lease = Lease::in_directory(
            Plan { bytes: 400 },
            Path::new(&root),
            Limits {
                total: 1000,
                available: 1000,
            },
        )
        .unwrap();
        println!("LEASE_READY");
        std::io::stdout().flush().unwrap();
        let mut byte = [0];
        let _ = std::io::stdin().read_exact(&mut byte);
    }
    #[test]
    fn separate_processes_share_admission_and_a_killed_process_releases_its_lock() {
        use std::{
            io::BufRead,
            process::{Command, Stdio},
        };
        let root = root();
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "indexed::resource_lease::tests::child_reservation_holder",
                "--nocapture",
            ])
            .env("HEAPLENS_RESOURCE_TEST_ROOT", root.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let output = std::io::BufReader::new(child.stdout.take().unwrap());
        let ready = output
            .lines()
            .map_while(std::result::Result::ok)
            .any(|s| s.contains("LEASE_READY"));
        let rejected = Lease::in_directory(
            Plan { bytes: 400 },
            root.path(),
            Limits {
                total: 1000,
                available: 1000,
            },
        )
        .is_err();
        let _ = child.kill();
        child.wait().unwrap();
        assert!(ready && rejected);
        Lease::in_directory(
            Plan { bytes: 700 },
            root.path(),
            Limits {
                total: 1000,
                available: 1000,
            },
        )
        .unwrap();
    }
}
