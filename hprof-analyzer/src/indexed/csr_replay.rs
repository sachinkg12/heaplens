//! Two extraction passes and per-row ordering avoid a global edge-triplet sort.
use super::edge_store::EdgeStore;
use anyhow::{ensure, Result};
type Edge = (u32, u32, u8);
type Emit<'a> = dyn FnMut(Edge) -> Result<()> + Send + 'a;

#[cfg(test)]
fn build(nodes: usize, replay: impl FnMut(&mut Emit<'_>) -> Result<()>) -> Result<EdgeStore> {
    build_cancellable(nodes, replay, &std::sync::atomic::AtomicBool::new(false))
}
#[cfg(test)]
fn build_cancellable(
    nodes: usize,
    mut replay: impl FnMut(&mut Emit<'_>) -> Result<()>,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<EdgeStore> {
    build_impl(
        nodes,
        |count, emit| {
            if count {
                replay(&mut |(src, dst, label)| {
                    ensure!((dst as usize) < nodes, "Invalid counted target");
                    emit((src, 1, label))
                })
            } else {
                replay(emit)
            }
        },
        false,
        cancel,
    )
}
pub(crate) fn build_upper(
    nodes: usize,
    replay: impl FnMut(bool, &mut Emit<'_>) -> Result<()>,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<EdgeStore> {
    build_impl(nodes, replay, true, cancel)
}
fn build_impl(
    nodes: usize,
    mut replay: impl FnMut(bool, &mut Emit<'_>) -> Result<()>,
    upper: bool,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<EdgeStore> {
    super::disk_edges::check(cancel)?;
    ensure!(
        nodes < u32::MAX as usize,
        "CSR node count exceeds supported width"
    );
    let mut offsets = vec![0u32; nodes + 1];
    let count_timer = super::stage_timer::StageTimer::start("csr.count_and_prefix");
    replay(true, &mut |(src, degree, label)| {
        super::disk_edges::check(cancel)?;
        ensure!(
            (src as usize) < nodes && super::edge_store::label::valid(label),
            "Invalid extracted edge"
        );
        offsets[src as usize + 1] = offsets[src as usize + 1]
            .checked_add(degree)
            .ok_or_else(|| anyhow::anyhow!("CSR degree overflow"))?;
        Ok(())
    })?;
    for i in 1..=nodes {
        offsets[i] = offsets[i]
            .checked_add(offsets[i - 1])
            .ok_or_else(|| anyhow::anyhow!("CSR edge count exceeds supported width"))?;
    }
    let total = offsets[nodes] as usize;
    drop(count_timer);
    let resolve_timer = super::stage_timer::StageTimer::start("csr.resolve_and_fill");
    // A packed target/label word is eight bytes, compared with twelve-byte
    // triplets. A temporary cursor column lets counting overestimate missing
    // targets without resolving the full ID lookup twice. It is released before
    // splitting the packed words into final CSR columns.
    let mut packed = Vec::new();
    packed.try_reserve_exact(total)?;
    packed.resize(total, u64::MAX);
    let mut cursors = Vec::new();
    cursors.try_reserve_exact(nodes)?;
    cursors.extend_from_slice(&offsets[1..]);
    let mut seen = 0usize;
    replay(false, &mut |(src, dst, label)| {
        super::disk_edges::check(cancel)?;
        ensure!(
            (src as usize) < nodes
                && (dst as usize) < nodes
                && super::edge_store::label::valid(label),
            "Invalid replayed edge"
        );
        let cursor = &mut cursors[src as usize];
        *cursor = cursor
            .checked_sub(1)
            .ok_or_else(|| anyhow::anyhow!("Inconsistent reference replay"))?;
        ensure!(
            *cursor >= offsets[src as usize] && (*cursor as usize) < total,
            "Inconsistent reference replay"
        );
        ensure!(
            packed[*cursor as usize] == u64::MAX,
            "Reference replay changed source counts"
        );
        packed[*cursor as usize] = (u64::from(dst) << 8) | u64::from(label);
        seen += 1;
        Ok(())
    })?;
    ensure!(
        upper || (seen == total && cursors.iter().zip(&offsets).all(|(a, b)| a == b)),
        "Reference replay count changed"
    );
    drop(cursors);
    drop(resolve_timer);
    let sort_timer = super::stage_timer::StageTimer::start("csr.row_sort_and_compact");
    let mut read_start = 0;
    let mut written = 0usize;
    for row in 0..nodes {
        if row % 4096 == 0 {
            super::disk_edges::check(cancel)?;
        }
        let end = offsets[row + 1] as usize;
        // Extraction can complete out of order. Sort each source's adjacency,
        // preserving the existing minimum-label rule for duplicate targets.
        let values = &mut packed[read_start..end];
        if values.len() >= 100_000 {
            use rayon::slice::ParallelSliceMut;
            values.par_sort_unstable();
        } else {
            values.sort_unstable();
        }
        offsets[row] = written as u32;
        let mut last = None;
        for read in read_start..end {
            let value = packed[read];
            if value == u64::MAX {
                break;
            }
            let target = value >> 8;
            if last != Some(target) {
                packed[written] = value;
                written += 1;
                last = Some(target);
            }
        }
        read_start = end;
    }
    offsets[nodes] = written as u32;
    drop(sort_timer);
    let split_timer = super::stage_timer::StageTimer::start("csr.split_columns");
    let mut targets = Vec::new();
    targets.try_reserve_exact(written)?;
    let mut labels = Vec::new();
    labels.try_reserve_exact(written)?;
    for &value in &packed[..written] {
        targets.push((value >> 8) as u32);
        labels.push(value as u8);
    }
    drop(packed);
    drop(split_timer);
    let _reverse_timer = super::stage_timer::StageTimer::start("csr.reverse_index");
    let mut reverse_offsets = vec![0u32; nodes + 1];
    for &target in &targets {
        reverse_offsets[target as usize + 1] += 1;
    }
    for i in 1..=nodes {
        reverse_offsets[i] += reverse_offsets[i - 1];
    }
    let mut reverse_targets = Vec::new();
    reverse_targets.try_reserve_exact(written)?;
    reverse_targets.resize(written, 0);
    for source in (0..nodes).rev() {
        if source % 4096 == 0 {
            super::disk_edges::check(cancel)?;
        }
        for &target in &targets[offsets[source] as usize..offsets[source + 1] as usize] {
            let cursor = &mut reverse_offsets[target as usize + 1];
            *cursor -= 1;
            reverse_targets[*cursor as usize] = source as u32;
        }
    }
    reverse_offsets.copy_within(1.., 0);
    reverse_offsets[nodes] = written as u32;
    Ok(EdgeStore {
        offsets: offsets.into(),
        targets: targets.into(),
        labels: labels.into(),
        reverse_offsets: reverse_offsets.into(),
        reverse_targets: reverse_targets.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::super::edge_store::EdgeBuilder;
    use super::*;
    #[test]
    fn replay_matches_triplets_for_duplicates_labels_empty_rows_shared_targets_and_cycles() {
        for nodes in [1usize, 7, 1000] {
            let edges: Vec<_> = (0..nodes as u32)
                .flat_map(|i| {
                    [
                        (i, (i + 1) % nodes as u32, 4),
                        (i, i, 3),
                        (i, 0, 1),
                        (i, 0, 0),
                    ]
                })
                .collect();
            let mut prior = EdgeBuilder::new();
            for &(s, t, l) in &edges {
                prior.add_edge(s, t, l);
            }
            let prior = prior.build(nodes);
            let built = build(nodes, |emit| {
                for &edge in edges.iter().rev() {
                    emit(edge)?;
                }
                Ok(())
            })
            .unwrap();
            for node in 0..nodes as u32 {
                assert_eq!(built.neighbor_labels(node), prior.neighbor_labels(node));
                assert_eq!(built.reverse_neighbors(node), prior.reverse_neighbors(node));
            }
        }
    }
    #[test]
    fn empty_invalid_and_changing_replays_are_rejected_or_empty() {
        let empty = build(4, |_| Ok(())).unwrap();
        assert_eq!(empty.edge_count(), 0);
        assert!(build(1, |emit| emit((0, 1, 0))).is_err());
        let mut pass = 0;
        assert!(build(1, |emit| {
            pass += 1;
            if pass == 1 {
                emit((0, 0, 0))?;
            }
            Ok(())
        })
        .is_err());
        let mut pass = 0;
        assert!(build(2, |emit| {
            pass += 1;
            emit((if pass == 1 { 0 } else { 1 }, 0, 0))
        })
        .is_err());
        assert!(
            build_cancellable(1, |_| Ok(()), &std::sync::atomic::AtomicBool::new(true)).is_err()
        );
    }
    #[test]
    fn upper_counts_allow_missing_targets_but_never_write_outside_the_source_row() {
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let graph = build_upper(
            4,
            |count, emit| {
                if count {
                    for src in 0..4 {
                        emit((src, 5, 0))?;
                    }
                } else {
                    for edge in [(0, 2, 1), (0, 2, 0), (3, 1, 0)] {
                        emit(edge)?;
                    }
                }
                Ok(())
            },
            &cancel,
        )
        .unwrap();
        assert_eq!(graph.neighbor_labels(0).0, &[2]);
        assert_eq!(graph.neighbor_labels(0).1, &[0]);
        assert!(graph.neighbors(1).is_empty());
        assert!(graph.neighbors(2).is_empty());
        assert_eq!(graph.neighbors(3), &[1]);
        assert_eq!(graph.reverse_neighbors(2), &[0]);
        assert!(build_upper(
            2,
            |count, emit| { emit((if count { 0 } else { 1 }, if count { 1 } else { 0 }, 0)) },
            &cancel
        )
        .is_err());
    }
}
