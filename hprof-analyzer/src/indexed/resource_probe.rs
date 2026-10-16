//! Read-only OS/cgroup observations. Available memory is a point-in-time hint.
use anyhow::{ensure, Context, Result};
#[derive(Clone, Copy, Debug)]
pub(super) struct Limits {
    pub total: u64,
    pub available: u64,
}
impl Limits {
    pub fn validate(self) -> Result<Self> {
        ensure!(
            self.total > 0 && self.available <= self.total,
            "Invalid OS memory observation"
        );
        Ok(self)
    }
}

#[cfg(target_os = "macos")]
pub(super) fn read() -> Result<Limits> {
    // vm_stat exposes page size in its header (16 KiB is not universal).
    let total = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.memsize"])
        .output()?;
    let pages = std::process::Command::new("/usr/bin/vm_stat").output()?;
    ensure!(
        total.status.success() && pages.status.success(),
        "Cannot inspect OS memory"
    );
    mac_pages(
        std::str::from_utf8(&total.stdout)?.trim().parse()?,
        std::str::from_utf8(&pages.stdout)?,
    )
}
#[cfg(any(target_os = "macos", test))]
fn mac_pages(total: u64, text: &str) -> Result<Limits> {
    let header = text.lines().next().context("Missing VM page size")?;
    let size: u64 = header
        .split("page size of ")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .context("Invalid VM page size")?
        .parse()?;
    ensure!(
        size.is_power_of_two() && (4096..=65536).contains(&size),
        "Invalid VM page size"
    );
    let mut reclaimable = 0u64;
    // Inactive includes both anonymous and file-backed pages. Count only
    // explicitly free/speculative pages and file-backed pages, not all inactive.
    for key in ["Pages free:", "Pages speculative:", "File-backed pages:"] {
        let count: u64 = text
            .lines()
            .find_map(|s| s.strip_prefix(key))
            .context("Missing VM counter")?
            .trim()
            .trim_end_matches('.')
            .parse()?;
        reclaimable = reclaimable
            .checked_add(count)
            .context("VM count overflow")?;
    }
    Limits {
        total,
        available: reclaimable
            .checked_mul(size)
            .context("VM byte overflow")?
            .min(total),
    }
    .validate()
}

#[cfg(target_os = "linux")]
pub(super) fn read() -> Result<Limits> {
    let text = std::fs::read_to_string("/proc/meminfo")?;
    let counter = |key: &str| -> Result<u64> {
        text.lines()
            .find_map(|s| s.strip_prefix(key))
            .and_then(|s| s.split_whitespace().next())
            .context("Missing OS memory counter")?
            .parse::<u64>()?
            .checked_mul(1024)
            .context("OS byte overflow")
    };
    let mut limits = Limits {
        total: counter("MemTotal:")?,
        available: counter("MemAvailable:")?,
    };
    let membership = std::fs::read_to_string("/proc/self/cgroup")?;
    if let Some(path) = membership.lines().find_map(|s| s.strip_prefix("0::")) {
        // Walk all accessible v2 ancestors; a parent can be the tighter limit.
        let root = std::path::Path::new("/sys/fs/cgroup");
        let relative = std::path::Path::new(path.trim_start_matches('/'));
        ensure!(
            relative
                .components()
                .all(|v| matches!(v, std::path::Component::Normal(_))),
            "Invalid cgroup path"
        );
        let mut current = root.join(relative);
        loop {
            if current.join("memory.max").exists() {
                apply_cgroup(
                    &mut limits,
                    &std::fs::read_to_string(current.join("memory.max"))?,
                    &std::fs::read_to_string(current.join("memory.current"))?,
                    reclaimable_file(
                        &std::fs::read_to_string(current.join("memory.stat"))?,
                        false,
                    )?,
                )?;
            }
            if current == root || !current.pop() {
                break;
            }
        }
    } else if let Some(path) = membership
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, ':');
            parts.next()?;
            let controllers = parts.next()?;
            let path = parts.next()?;
            controllers
                .split(',')
                .any(|c| c == "memory")
                .then_some(path)
        })
        .next()
    {
        let root = std::path::Path::new("/sys/fs/cgroup/memory");
        let relative = std::path::Path::new(path.trim_start_matches('/'));
        ensure!(
            relative
                .components()
                .all(|v| matches!(v, std::path::Component::Normal(_))),
            "Invalid cgroup path"
        );
        let mut current = root.join(relative);
        let mut observed = false;
        loop {
            if current.join("memory.limit_in_bytes").exists() {
                apply_cgroup(
                    &mut limits,
                    &std::fs::read_to_string(current.join("memory.limit_in_bytes"))?,
                    &std::fs::read_to_string(current.join("memory.usage_in_bytes"))?,
                    reclaimable_file(&std::fs::read_to_string(current.join("memory.stat"))?, true)?,
                )?;
                observed = true;
            }
            if current == root || !current.pop() {
                break;
            }
        }
        ensure!(observed, "Cannot inspect the memory controller limit");
    }
    limits.validate()
}
#[cfg(any(target_os = "linux", test))]
fn apply_cgroup(limits: &mut Limits, max: &str, used: &str, reclaimable: u64) -> Result<()> {
    if max.trim() == "max" {
        return Ok(());
    }
    let max: u64 = max.trim().parse()?;
    let used: u64 = used.trim().parse()?;
    ensure!(max > 0, "Invalid cgroup memory limit");
    limits.total = limits.total.min(max);
    // memory.current includes filesystem cache. Treating every cached input
    // page as irreclaimable would reject warm opens after the input hash.
    // This remains an estimate, not a promise of immediate reclaimability.
    limits.available = limits
        .available
        .min(max.saturating_sub(used.saturating_sub(reclaimable)));
    Ok(())
}
#[cfg(any(target_os = "linux", test))]
fn reclaimable_file(stat: &str, legacy: bool) -> Result<u64> {
    let counter = |key: &str| -> Result<Option<u64>> {
        for line in stat.lines() {
            let mut parts = line.split_whitespace();
            if parts.next() == Some(key) {
                return Ok(Some(parts.next().context("Missing cgroup value")?.parse()?));
            }
        }
        Ok(None)
    };
    let (inactive, dirty, writeback) = if legacy {
        (
            counter("total_inactive_file")?
                .or(counter("inactive_file")?)
                .unwrap_or(0),
            counter("total_dirty")?.or(counter("dirty")?).unwrap_or(0),
            counter("total_writeback")?
                .or(counter("writeback")?)
                .unwrap_or(0),
        )
    } else {
        (
            counter("inactive_file")?.unwrap_or(0),
            counter("file_dirty")?.unwrap_or(0),
            counter("file_writeback")?.unwrap_or(0),
        )
    };
    // Never credit anonymous memory, swap, or dirty/writeback file pages.
    Ok(inactive.saturating_sub(dirty.saturating_add(writeback)))
}

#[cfg(windows)]
pub(super) fn read() -> Result<Limits> {
    #[repr(C)]
    struct Status {
        length: u32,
        load: u32,
        total: u64,
        available: u64,
        page_total: u64,
        page_available: u64,
        virtual_total: u64,
        virtual_available: u64,
        extended: u64,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut Status) -> i32;
    }
    let mut status = Status {
        length: std::mem::size_of::<Status>() as u32,
        load: 0,
        total: 0,
        available: 0,
        page_total: 0,
        page_available: 0,
        virtual_total: 0,
        virtual_available: 0,
        extended: 0,
    };
    ensure!(
        unsafe { GlobalMemoryStatusEx(&mut status) } != 0,
        "Cannot inspect OS memory"
    );
    Limits {
        total: status.total,
        available: status.available,
    }
    .validate()
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(super) fn read() -> Result<Limits> {
    anyhow::bail!("OS memory admission is unavailable on this target")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_page_size_and_never_counts_anonymous_inactive_as_free() {
        let value = mac_pages(1024*1024, "VM (page size of 4096 bytes)\nPages free: 10.\nPages speculative: 2.\nFile-backed pages: 4.\nPages inactive: 99999.").unwrap();
        assert_eq!(value.available, 16 * 4096);
        assert!(mac_pages(1000, "missing").is_err());
    }
    #[test]
    fn cgroup_headroom_and_parent_limits_are_honored_without_swap_credit() {
        let mut value = Limits {
            total: 1000,
            available: 900,
        };
        apply_cgroup(&mut value, "500", "200", 0).unwrap();
        apply_cgroup(&mut value, "400", "350", 0).unwrap();
        assert_eq!((value.total, value.available), (400, 50));
        apply_cgroup(&mut value, "max", "ignored", 0).unwrap();
        apply_cgroup(&mut value, "400", "500", 0).unwrap();
        assert_eq!(value.available, 0);
    }
    #[test]
    fn warm_file_cache_is_not_mistaken_for_irreclaimable_container_usage() {
        let cache = reclaimable_file(
            "inactive_file 700\nfile_dirty 50\nfile_writeback 20\nanon 99999\nswapcached 123",
            false,
        )
        .unwrap();
        assert_eq!(cache, 630);
        let mut value = Limits {
            total: 2000,
            available: 1500,
        };
        apply_cgroup(&mut value, "1000", "950", cache).unwrap();
        assert_eq!((value.total, value.available), (1000, 680));
        assert_eq!(
            reclaimable_file(
                "inactive_file 900\ntotal_inactive_file 600\ntotal_dirty 50\ntotal_writeback 50",
                true
            )
            .unwrap(),
            500
        );
        assert_eq!(reclaimable_file("anon 1000", false).unwrap(), 0);
        assert!(reclaimable_file("inactive_file broken", false).is_err());
    }
}
