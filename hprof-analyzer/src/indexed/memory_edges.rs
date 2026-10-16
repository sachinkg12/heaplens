//! Choose by bounded staging cost, not dump-file size or another user setting.
use super::{
    edge_store::{EdgeBuilder, EdgeStore},
    parse::{DeferredEdgeData, Phase1Result},
};
use anyhow::Result;
use std::sync::atomic::AtomicBool;
const FAST_STAGING_BYTES: usize = 256 * 1024 * 1024;
pub(crate) fn single_pass(references: usize) -> bool {
    references
        .checked_mul(std::mem::size_of::<(u32, u32, u8)>())
        .is_some_and(|bytes| bytes <= FAST_STAGING_BYTES)
}
pub(crate) fn build(
    phase: &Phase1Result,
    deferred: &DeferredEdgeData,
    cancel: &AtomicBool,
) -> Result<EdgeStore> {
    if single_pass(deferred.max_references) {
        log::info!(
            "Memory graph builder: single-pass staging, validated upper bound {} bytes",
            deferred.max_references * std::mem::size_of::<(u32, u32, u8)>()
        );
        let mut builder = EdgeBuilder::try_with_capacity(deferred.max_references)?;
        deferred.deferred_instances.extract(
            |instance, emit| {
                super::edge_extract::instance(instance, deferred, phase, |s, t, l| emit((s, t, l)))
            },
            |batch| {
                super::disk_edges::check(cancel)?;
                builder.extend_bounded(batch, deferred.max_references)
            },
        )?;
        super::edge_extract::structural(deferred, phase, |s, t, l| {
            super::disk_edges::check(cancel)?;
            builder.extend_bounded(&[(s, t, l)], deferred.max_references)
        })?;
        super::disk_edges::check(cancel)?;
        return Ok(builder.build(phase.node_store.len()));
    }
    log::info!("Memory graph builder: count-and-resolve packed CSR (large staging avoided)");
    super::csr_replay::build_upper(
        phase.node_store.len(),
        |count, emit| {
            deferred.deferred_instances.extract(
                |instance, emit| {
                    if count {
                        super::edge_extract::count_instance(instance, deferred, phase, |s, t, l| {
                            emit((s, t, l))
                        })
                    } else {
                        super::edge_extract::instance(instance, deferred, phase, |s, t, l| {
                            emit((s, t, l))
                        })
                    }
                },
                |batch| {
                    for &edge in batch {
                        emit(edge)?;
                    }
                    Ok(())
                },
            )?;
            if count {
                super::edge_extract::count_structural(deferred, phase, |s, t, l| emit((s, t, l)))
            } else {
                super::edge_extract::structural(deferred, phase, |s, t, l| emit((s, t, l)))
            }
        },
        cancel,
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn staging_selection_is_bounded_and_overflow_cannot_select_the_fast_path() {
        let limit = FAST_STAGING_BYTES / std::mem::size_of::<(u32, u32, u8)>();
        assert!(single_pass(0));
        assert!(single_pass(limit));
        assert!(!single_pass(limit + 1));
        assert!(!single_pass(usize::MAX));
        assert!(EdgeBuilder::try_with_capacity(1)
            .unwrap()
            .extend_bounded(&[(0, 0, 0), (0, 0, 0)], 1)
            .is_err());
    }
}
