//! Bounded parallel extraction scratch; the destination graph is separate.

use anyhow::{ensure, Result};
use rayon::prelude::*;
use std::sync::mpsc;

type Edge = (u32, u32, u8);
const SCRATCH_BYTES: usize = 4 * 1024 * 1024;
const ITEMS_PER_CHUNK: usize = 10_000;

struct BatchPlan {
    queue_depth: usize,
    edges_per_buffer: usize,
}

impl BatchPlan {
    fn new(bytes: usize, workers: usize) -> Result<Self> {
        ensure!(workers > 0, "Edge extraction needs a worker");
        let queue_depth = workers.min(8);
        // One buffer per worker (including blocked sends), queued buffers and
        // the consumer's current buffer. A sender allocates its replacement
        // only AFTER its previous send finishes.
        let buffers = workers
            .checked_add(queue_depth)
            .and_then(|n| n.checked_add(1))
            .ok_or_else(|| anyhow::anyhow!("Invalid extraction worker count"))?;
        let edges_per_buffer = bytes / buffers / std::mem::size_of::<Edge>();
        ensure!(
            edges_per_buffer > 0,
            "Edge extraction scratch budget too small"
        );
        Ok(Self {
            queue_depth,
            edges_per_buffer,
        })
    }
}

pub(super) fn extract<T, F>(
    items: &[T],
    extract_item: F,
    mut consume: impl FnMut(&[Edge]) -> Result<()> + Send,
) -> Result<()>
where
    T: Sync,
    F: Fn(&T, &mut dyn FnMut(Edge) -> Result<()>) -> Result<()> + Sync,
{
    if items.len() < ITEMS_PER_CHUNK {
        for item in items {
            extract_item(item, &mut |edge| consume(std::slice::from_ref(&edge)))?;
        }
        return Ok(());
    }
    parallel(items, &extract_item, &mut consume, SCRATCH_BYTES)
}

fn parallel<T, F>(
    items: &[T],
    extract_item: &F,
    consume: &mut (impl FnMut(&[Edge]) -> Result<()> + Send),
    bytes: usize,
) -> Result<()>
where
    T: Sync,
    F: Fn(&T, &mut dyn FnMut(Edge) -> Result<()>) -> Result<()> + Sync,
{
    let plan = BatchPlan::new(bytes, rayon::current_num_threads())?;
    let (sender, receiver) = mpsc::sync_channel::<Vec<Edge>>(plan.queue_depth);
    std::thread::scope(|scope| {
        // The consumer must never occupy a Rayon worker: callers may already
        // be running on that pool, including a pool with just one worker.
        // Consumption only appends to the destination; it does not submit jobs.
        let consumer = std::thread::Builder::new()
            .name("heaplens-edge-consumer".into())
            .spawn_scoped(scope, move || {
                receiver.iter().try_for_each(|batch| consume(&batch))
            })?;
        // Extraction stays on the caller's pool, so worker accounting and
        // nested Rayon execution use the same pool rather than switching pools.
        let produced = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            items
                .par_chunks(ITEMS_PER_CHUNK)
                .try_for_each(|chunk| -> Result<()> {
                    let mut buffer = Vec::new();
                    let mut emit = |edge| -> Result<()> {
                        if buffer.capacity() == 0 {
                            buffer.try_reserve_exact(plan.edges_per_buffer)?;
                        }
                        buffer.push(edge);
                        if buffer.len() == plan.edges_per_buffer {
                            sender
                                .send(std::mem::take(&mut buffer))
                                .map_err(|_| anyhow::anyhow!("Edge consumer stopped"))?;
                        }
                        Ok(())
                    };
                    for item in chunk {
                        extract_item(item, &mut emit)?;
                    }
                    if !buffer.is_empty() {
                        sender
                            .send(buffer)
                            .map_err(|_| anyhow::anyhow!("Edge consumer stopped"))?;
                    }
                    Ok(())
                })
        }))
        .map_err(|_| anyhow::anyhow!("Edge extraction worker panicked"));
        // Closing the last sender releases the consumer on success, failure
        // or a caught extraction panic. Consumer failure drops its receiver,
        // releasing blocked producers without waiting for a pool job.
        drop(sender);
        let consumed = consumer
            .join()
            .map_err(|_| anyhow::anyhow!("Edge consumer panicked"));
        consumed??;
        produced?
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scratch_plan_bounds_all_producer_queue_and_consumer_buffers() {
        for workers in [1, 2, 8, 16, 128] {
            let plan = BatchPlan::new(SCRATCH_BYTES, workers).unwrap();
            assert!(
                (workers + plan.queue_depth + 1)
                    * plan.edges_per_buffer
                    * std::mem::size_of::<Edge>()
                    <= SCRATCH_BYTES
            );
        }
        assert!(BatchPlan::new(0, 1).is_err());
        assert!(BatchPlan::new(SCRATCH_BYTES, 0).is_err());
        assert!(BatchPlan::new(SCRATCH_BYTES, usize::MAX).is_err());
    }

    #[test]
    fn a_single_high_degree_item_is_split_across_bounded_batches() {
        let items = [100_003u32];
        let mut seen = Vec::new();
        let budget = 4096;
        let plan = BatchPlan::new(budget, rayon::current_num_threads()).unwrap();
        parallel(
            &items,
            &|&count, emit: &mut dyn FnMut(Edge) -> Result<()>| {
                for i in 0..count {
                    emit((0, i, 1))?;
                }
                Ok(())
            },
            &mut |batch: &[Edge]| {
                assert!(batch.len() <= plan.edges_per_buffer);
                seen.extend_from_slice(batch);
                Ok(())
            },
            budget,
        )
        .unwrap();
        assert_eq!(seen, (0..items[0]).map(|i| (0, i, 1)).collect::<Vec<_>>());
    }

    #[test]
    fn parallel_output_matches_sequential_for_every_edge() {
        let items: Vec<_> = (0..40_001u32).collect();
        let mut output = Vec::new();
        extract(
            &items,
            |&src, emit| {
                for i in 0..(src % 7) {
                    emit((src, i, (i % 3) as u8))?;
                }
                Ok(())
            },
            |batch| {
                output.extend_from_slice(batch);
                Ok(())
            },
        )
        .unwrap();
        output.sort_unstable();
        let expected: Vec<_> = items
            .iter()
            .flat_map(|&src| (0..src % 7).map(move |i| (src, i, (i % 3) as u8)))
            .collect();
        assert_eq!(output, expected);
    }

    #[test]
    fn producer_error_is_returned_without_leaking_a_worker() {
        let error = parallel(
            &[0u32],
            &|_, emit: &mut dyn FnMut(Edge) -> Result<()>| {
                emit((0, 1, 1))?;
                anyhow::bail!("fixture producer error")
            },
            &mut |_: &[Edge]| Ok(()),
            SCRATCH_BYTES,
        )
        .unwrap_err();
        assert!(error.to_string().contains("fixture producer error"));
    }

    #[test]
    fn consumer_error_releases_blocked_producers() {
        let items: Vec<_> = (0..40_001u32).collect();
        let error = parallel(
            &items,
            &|&src, emit: &mut dyn FnMut(Edge) -> Result<()>| {
                for dst in 0..100 {
                    emit((src, dst, 1))?;
                }
                Ok(())
            },
            &mut |_: &[Edge]| anyhow::bail!("fixture consumer error"),
            4096,
        )
        .unwrap_err();
        assert!(error.to_string().contains("fixture consumer error"));
    }

    #[test]
    fn empty_input_and_call_from_single_worker_do_not_starve_consumer() {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        pool.install(|| {
            parallel(
                &[7u32],
                &|&src, emit: &mut dyn FnMut(Edge) -> Result<()>| emit((src, 0, 1)),
                &mut |batch: &[Edge]| {
                    assert_eq!(batch, &[(7, 0, 1)]);
                    Ok(())
                },
                4096,
            )
            .unwrap();
        });
        extract::<u32, _>(&[], |_, _| panic!("no items"), |_| panic!("no edges")).unwrap();
    }

    #[test]
    fn nested_parallel_analyses_complete_on_a_single_worker_pool() {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        pool.install(|| {
            (0..4).into_par_iter().for_each(|job| {
                let items: Vec<_> = (0..20_001u32).collect();
                let mut total = 0usize;
                extract(
                    &items,
                    |&src, emit| emit((src, job, 1)),
                    |batch| {
                        total += batch.len();
                        Ok(())
                    },
                )
                .unwrap();
                assert_eq!(total, items.len());
            });
        });
    }

    #[test]
    fn extraction_panic_closes_the_channel_before_join() {
        let error = parallel(
            &[0u32],
            &|_, _: &mut dyn FnMut(Edge) -> Result<()>| {
                panic!("fixture extraction panic");
            },
            &mut |_: &[Edge]| Ok(()),
            SCRATCH_BYTES,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "Edge extraction worker panicked");
    }

    #[test]
    fn consumer_panic_releases_blocked_producers() {
        let items: Vec<_> = (0..20_001u32).collect();
        let error = parallel(
            &items,
            &|&src, emit: &mut dyn FnMut(Edge) -> Result<()>| {
                for dst in 0..100 {
                    emit((src, dst, 1))?;
                }
                Ok(())
            },
            &mut |_: &[Edge]| panic!("fixture consumer panic"),
            4096,
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "Edge consumer panicked");
    }
}
