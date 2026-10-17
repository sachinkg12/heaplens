//! In-place MSD radix experiment for fixed-width edge tuples. No N-sized scratch.
use anyhow::Result;
use std::sync::atomic::AtomicBool;
type Edge = (u32, u32, u8);
fn digit(edge: Edge, byte: usize) -> usize {
    match byte {
        0..=3 => ((edge.0 >> (24 - byte * 8)) & 255) as usize,
        4..=7 => ((edge.1 >> (56 - byte * 8)) & 255) as usize,
        _ => edge.2 as usize,
    }
}
pub(crate) fn sort(values: &mut [Edge], cancel: &AtomicBool) -> Result<()> {
    if values.windows(2).all(|w| w[0] <= w[1]) {
        return super::disk_edges::check(cancel);
    }
    partition(values, 0, cancel)
}
fn partition(values: &mut [Edge], byte: usize, cancel: &AtomicBool) -> Result<()> {
    super::disk_edges::check(cancel)?;
    if values.len() <= 64 {
        values.sort_unstable();
        return Ok(());
    }
    let mut counts = [0usize; 256];
    for (i, &value) in values.iter().enumerate() {
        if i % 4096 == 0 {
            super::disk_edges::check(cancel)?;
        }
        counts[digit(value, byte)] += 1;
    }
    let mut starts = [0usize; 257];
    for i in 0..256 {
        starts[i + 1] = starts[i] + counts[i];
    }
    let mut next = [0usize; 256];
    next.copy_from_slice(&starts[..256]);
    let mut steps = 0usize;
    for bucket in 0..256 {
        while next[bucket] < starts[bucket + 1] {
            if steps % 4096 == 0 {
                super::disk_edges::check(cancel)?;
            }
            steps += 1;
            let target = digit(values[next[bucket]], byte);
            if target == bucket {
                next[bucket] += 1;
            } else {
                values.swap(next[bucket], next[target]);
                next[target] += 1;
            }
        }
    }
    if byte < 8 {
        for bucket in 0..256 {
            if counts[bucket] > 1 {
                partition(
                    &mut values[starts[bucket]..starts[bucket + 1]],
                    byte + 1,
                    cancel,
                )?;
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn values(n: usize, case: usize) -> Vec<Edge> {
        let mut seed = 0x28d1_79af_4923_e651u64;
        (0..n)
            .map(|i| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let a = (seed >> 32) as u32;
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let b = (seed >> 32) as u32;
                match case {
                    0 => (a, b, (a % 7) as u8),
                    1 => (i as u32 / 3, b, (a % 7) as u8),
                    2 => ((n - i) as u32 / 3, b, (a % 7) as u8),
                    3 => (7, b % 1024, (a % 7) as u8),
                    _ => (a % 17, b % 17, (a % 7) as u8),
                }
            })
            .collect()
    }
    #[test]
    fn radix_matches_tuple_order_for_all_bytes_distributions_and_duplicate_labels() {
        let cancel = AtomicBool::new(false);
        for n in [0, 1, 63, 64, 65, 257, 4096, 10003] {
            for case in 0..5 {
                let mut actual = values(n, case);
                let mut expected = actual.clone();
                expected.sort_unstable();
                sort(&mut actual, &cancel).unwrap();
                assert_eq!(actual, expected);
            }
        }
        assert!(sort(&mut values(10000, 0), &AtomicBool::new(true)).is_err());
    }
    #[test]
    #[ignore = "explicit optimized sort experiment, not a CI timing assertion"]
    fn compare_run_sorters() {
        let cancel = AtomicBool::new(false);
        for n in [262_144, 1_000_000] {
            for case in 0..5 {
                for round in 0..3 {
                    let input = values(n, case);
                    let mut comparison = input.clone();
                    let mut radix = input.clone();
                    let start = std::time::Instant::now();
                    comparison.sort_unstable();
                    let comparison_ns = start.elapsed().as_nanos();
                    let start = std::time::Instant::now();
                    sort(&mut radix, &cancel).unwrap();
                    let radix_ns = start.elapsed().as_nanos();
                    assert_eq!(comparison, radix);
                    println!("SORT_CASE n={n} case={case} round={round} comparison_ns={comparison_ns} radix_ns={radix_ns}");
                }
            }
        }
    }
}
