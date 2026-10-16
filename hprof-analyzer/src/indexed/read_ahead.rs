//! Bounded read-only hints for the first sequential structural scan.
//! Never evicts pages or changes mapping contents; unsupported hints are optional.
pub(crate) struct ReadAhead<'a> {
    mapping: Option<&'a memmap2::Mmap>,
    next_at: usize,
}
const WINDOW: usize = 16 * 1024 * 1024;
const ALIGN: usize = 64 * 1024;
impl<'a> ReadAhead<'a> {
    pub fn new(mapping: Option<&'a memmap2::Mmap>) -> Self {
        let mut value = Self { mapping: mapping.filter(|m| m.len() >= 256 * 1024 * 1024), next_at: 0 };
        value.observe(0);
        value
    }
    pub fn observe(&mut self, position: usize) {
        let Some(mapping) = self.mapping else { return; };
        if position < self.next_at || position >= mapping.len() { return; }
        let start = position / ALIGN * ALIGN;
        let length = WINDOW.min(mapping.len() - start);
        #[cfg(unix)]
        if mapping.advise_range(memmap2::Advice::WillNeed, start, length).is_err() {
            self.mapping = None;
        }
        self.next_at = start + WINDOW / 2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hints_are_bounded_skip_repeats_and_never_change_bytes() {
        let mut writable = memmap2::MmapMut::map_anon(256 * 1024 * 1024).unwrap();
        writable[0]=17; writable[WINDOW]=29;
        let map=writable.make_read_only().unwrap();
        let mut ahead=ReadAhead::new(Some(&map));
        assert_eq!(ahead.next_at, WINDOW/2);
        if ahead.mapping.is_none() { assert_eq!((map[0],map[WINDOW]),(17,29)); return; }
        ahead.observe(1); assert_eq!(ahead.next_at, WINDOW/2);
        ahead.observe(WINDOW); assert_eq!(ahead.next_at, WINDOW+WINDOW/2);
        ahead.observe(map.len()-1); let end=ahead.next_at;
        ahead.observe(map.len()); assert_eq!(ahead.next_at,end);
        assert_eq!((map[0],map[WINDOW]),(17,29));
    }
}
