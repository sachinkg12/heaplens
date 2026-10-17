//! Narrow, evidence-selected VM additions to the ordinary Java-field estimate.
//! A profile is not a claim of byte-exact sizing for arbitrary user classes.
use crate::object_layout::ObjectLayout;

pub(crate) const HOME_BREW_21: &str = "hotspot-homebrew-21.0.12.1-injected-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct InjectedFields {
    pub native_words: u64,
    pub ints: u64,
    pub shorts: u64,
    pub booleans: u64,
}
impl InjectedFields {
    pub fn bytes(self, layout: ObjectLayout) -> anyhow::Result<u64> {
        self.native_words
            .checked_mul(layout.word_bytes)
            .and_then(|n| self.ints.checked_mul(4).and_then(|i| n.checked_add(i)))
            .and_then(|n| self.shorts.checked_mul(2).and_then(|s| n.checked_add(s)))
            .and_then(|n| n.checked_add(self.booleans))
            .ok_or_else(|| anyhow::anyhow!("Injected-field extent overflow"))
    }
}

pub(crate) const CLASS_LOADER: InjectedFields = InjectedFields {
    native_words: 1,
    ints: 0,
    shorts: 0,
    booleans: 0,
};
// Native JVMTI state, VTMS transition counter/flag, and the JFR epoch.
// This field set is selected only for the producer build independently tested.
pub(crate) const THREAD_21: InjectedFields = InjectedFields {
    native_words: 1,
    ints: 1,
    shorts: 1,
    booleans: 1,
};

/// Deliberately start with one measured build. Similar class names, a major
/// version, or the analyzer's own Java installation do not select a profile.
pub(crate) fn select(vm: &str, vendor: &str, version: &str) -> Option<&'static str> {
    match (vm, vendor, version) {
        ("OpenJDK 64-Bit Server VM", "Homebrew", "21.0.12.1") => Some(HOME_BREW_21),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_requires_the_measured_producer_not_a_substring_or_major_version() {
        assert_eq!(
            select("OpenJDK 64-Bit Server VM", "Homebrew", "21.0.12.1"),
            Some(HOME_BREW_21)
        );
        for (vm, vendor, version) in [
            ("OpenJ9", "Homebrew", "21.0.12.1"),
            ("OpenJDK 64-Bit Server VM", "Other", "21.0.12.1"),
            ("OpenJDK 64-Bit Server VM", "Homebrew", "21.0.12"),
            ("OpenJDK 64-Bit Server VM", "Homebrew", "21.0.13"),
            ("OpenJDK 64-Bit Server VM", "Homebrew", "21.0.12.1 extra"),
        ] {
            assert_eq!(select(vm, vendor, version), None);
        }
    }
    #[test]
    fn typed_vm_fields_do_not_confuse_native_pointers_with_compressed_references() {
        for references in [4, 8] {
            let layout = ObjectLayout::new(8, references, 4, 8).unwrap();
            assert_eq!(CLASS_LOADER.bytes(layout).unwrap(), 8);
            assert_eq!(THREAD_21.bytes(layout).unwrap(), 15);
        }
        assert!(InjectedFields {
            native_words: u64::MAX,
            ..CLASS_LOADER
        }
        .bytes(ObjectLayout::new(8, 4, 4, 8).unwrap())
        .is_err());
    }
}
