---
sidebar_position: 4
title: Leak Suspects
---

Use By Object / By Class, percentage filtering, retained sizes, descriptions, and accumulation-point information to choose an investigation. These are **heuristic candidates**, not confirmed leaks.

## Validate a candidate

1. Identify storage versus owner: a high byte-array total does not name the retention cause.
2. Follow Why alive / referrers and inspect field values locally.
3. Inspect lifecycle intent: active versus obsolete connections, bounded capacity, classloader state.
4. Compare equivalent captures after completed work/GC.

A large map may be expected; a loader may be current. The empty state depends on detector and UI filtering, not one universal 5% rule. See [detector thresholds](../concepts/leak-detection.md).

## Explain and repair

Explain sends minimized metadata to the configured provider, not raw primitive field contents. Different models and host prompts can produce substantially different advice. Large retained bytes do not prove that closing a stream frees the arrays; ByteArrayOutputStream close does not release its buffer.

Source/Fix with AI acts only on resolvable project source, with full-file approval. A generated proposal needs review, tests, and equivalent post-change captures.

## Counts and overlap

A class-level total does not imply that every instance has the size of the single example being inspected. Class/object totals can overlap other candidates. Do not add candidate retention together or interpret model confidence as a calibrated detector probability.

See [AI privacy](../ai-integration/privacy.md), [Inspector](./object-inspector.md), and [Compare](./compare-tab.md).
