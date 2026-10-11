---
title: Previously recorded measurements
---

These are **historical figures carried over from the earlier documentation**, not rerun or independently validated during the October 11, 2026 site refresh. Values are preserved, including approximate notation. Missing fixture hashes, exact versions, full logs, and cache conditions limit reproducibility.

## Earlier performance table

The old page attributed this table to an M1 MacBook Pro with 16 GB RAM and Rayon parallelization:

| File | Size | Objects | Edges | Phase 1 | Phase 2 + dominators | Total |
| --- | --- | --- | --- | --- | --- | --- |
| Small service | 26 MB | 400K | 1.2M | < 0.2s | ~0.3s | ~0.5s |
| Medium app | 212 MB | 3.1M | 12M | ~0.3s | ~0.8s | ~1.1s |
| Large app | 1.5 GB | ~12M | ~50M | ~0.4s | ~0.5s | ~0.9s |
| Large monolith | 2 GB | ~16M | ~65M | ~0.5s | ~0.7s | ~1.2s |
| Very large | 14 GB | ~100M | ~400M | ~2s | ~8.5s | ~10.5s |

The previous Rust guide repeated 1.5 GB/~0.9s, 2 GB/~1.2s, and 14 GB/~10.5s. Its memory tables claimed ~2–3× file size during graph building, ~3–4× peak, and ~1–2× cached usage elsewhere. Those **unsupported universal ratios and the 14 GB/16 GB machine attribution require original logs**, not guessed replacement measurements.

The old homepage also claimed a 1 GB/~60-second M1 result. Differences cannot be resolved without version/workload/phase provenance. These numbers are not an installation requirement or prediction for another dump.

## How to use historical evidence

Preserve the original source record, identify uncertainty, and do not describe a documentation migration as a new validation. Independently recorded JVM/reference-analyzer sizing checks remain distinct from HeapLens-generated results. No submitted/published paper or historical benchmark artifact was modified by this refresh.

For actionable resource guidance use [performance](./performance-tuning.md). A future reproducible measurement set should record fixture identity, source commit/backend, JVM layout, machine/OS, phase scope, cold/warm cache, trials, RSS, and failures.
