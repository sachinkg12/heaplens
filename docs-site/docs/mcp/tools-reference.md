---
sidebar_position: 3
title: Scoped MCP metadata tools
---

These six tools belong to the updated local implementation. Use `tools/list` on the executable you launch. Launch-time exact-file approval and `--mcp-share-metadata` are required; request arguments cannot grant permission.

| Tool | Required arguments | Result |
| --- | --- | --- |
| list_dumps | Empty object | Approved aliases such as dump_1; no local paths |
| analyze_heap | dump_id | New analysis identity and bounded summary evidence; replaces previous state |
| get_summary | dump_id, analysis_id | Sizes/counts and up to 15 retained-object descriptors |
| investigate_heap | dump_id, analysis_id, action | One bounded metadata read |
| get_evidence | dump_id, analysis_id, evidence_id | A previously returned record from this analysis |
| close_dump | dump_id, analysis_id | Releases state and invalidates its evidence |

Only `object`, `fields`, `outbound`, `referrers`, `children` and `root_path` are accepted actions. Field reads return names/types, not contents. Unknown operations, numeric IDs, extra arguments, arbitrary paths and legacy unrestricted tools fail closed.

## Read an object

Replace illustrative identities with ones actually returned for your dump:

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"investigate_heap","arguments":{"dump_id":"dump_1","analysis_id":"A1","action":{"operation":"object","object_id":"512"}}}}
```

Tools return MCP text content containing JSON and an `isError` flag. Success data includes the analysis identity and evidence record; the record has an opaque ID, scope, operation and bounded data. Errors do not echo paths or submitted arguments. Missing evidence, exhausted search or an empty prefix does not prove absence.

## Interpretation

Handles establish provenance within one process and analysis, not causal truth or a cryptographic certificate. Class retained totals overlap across classes; retention is not proof of a leak. A snapshot cannot establish growth, intended lifetime or whether a repair works.

The external client owns its model reasoning and can still generate unsupported prose. HeapLens's built-in evidence-linked answer renderer is a separate host feature. See [limits](./setup.md), [size semantics](../concepts/retained-vs-shallow-size.md) and [privacy](../ai-integration/privacy.md).
