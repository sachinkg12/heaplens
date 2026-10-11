---
title: Object Inspector and Explain
---

Inspect shows field names/types, locally available primitive values, and reference summaries for a selected object. It complements—not replaces—the dominator tree.

## Navigate evidence

- Follow a reference to inspect the target.
- Show referrers to find incoming objects.
- Why alive returns a bounded recorded root route.
- Use available Back/drill controls to return to your investigation.

Field names and array indexes are shown when available. Synthetic roots/class nodes, unknown IDs, unsupported layouts, and bounded array results have different behavior; an empty field list is not proof an object holds nothing.

A dominator relationship is not necessarily a direct field. Unreachable cycles are collectible; “break all circular references” is not a correct general repair.

## Explain

Explain supplies minimized field types/names and reference/size metadata. Raw primitive values remain local in this prompt policy; **MCP inspection can return them**. A model cannot establish lifecycle intent from missing context.

Verify model advice against actual fields and paths. WeakHashMap, stream closure, and generated before/after code are not universal fixes. Source and full-file approval are independent actions.

If configuration is missing, configure a valid provider/key or keyless local Ollama. Stop should only be available for a running AI action, not suggest background work while idle. Provider errors should not expose keys or private URLs.

Read [AI privacy](../ai-integration/privacy.md), [GC roots](../concepts/gc-roots.md), and [Source](./source-tab.md).
