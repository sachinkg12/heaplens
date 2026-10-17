//! Larger sequential I/O buffers replace, rather than add to, sort workspace.
pub(crate) const FAN_IN: usize = 32;
pub(crate) fn split(bytes: usize, legacy_io: usize) -> (usize, usize) {
    if bytes < 1024 * 1024 {
        return (bytes, legacy_io);
    }
    let io = (bytes / (16 * FAN_IN)).clamp(legacy_io, 128 * 1024);
    (bytes - (FAN_IN + 1) * io, io)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merge_readers_and_writer_fit_the_existing_large_sort_budget() {
        for bytes in [
            1024 * 1024,
            16 * 1024 * 1024,
            64 * 1024 * 1024,
            65 * 1024 * 1024,
        ] {
            for old in [4096, 8192] {
                let (rows, io) = split(bytes, old);
                assert_eq!(rows + (FAN_IN + 1) * io, bytes);
                assert!(io >= old && rows > 0);
            }
        }
        assert_eq!(split(48, 4096), (48, 4096));
    }
}
