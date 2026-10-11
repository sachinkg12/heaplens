---
sidebar_position: 1
title: System architecture
---

import FlowDiagram from '@site/src/components/FlowDiagram';

HeapLens separates analysis from its host. The shared Rust engine serves VS Code, IntelliJ, standalone commands/browser, and MCP through different adapters.

<FlowDiagram />

## Shared versus host-specific

| Shared engine | Host responsibilities |
| --- | --- |
| HPROF parsing and layout estimates | File/path selection and native executable target |
| Retaining reference graph / CSR | Process lifecycle, cancellation, Retry, request routing |
| Dominators and retained sizes | Theme, UI bridge, paging, clipboard/save/download |
| Histograms, suspects, waste, HeapQL | Source lookup, credentials, AI approval/history, proposals |
| Compact comparison/timeline data | Host preferences and telemetry policy |

Reusing renderers/contracts does not mean the whole VS Code extension runs unchanged in IntelliJ. Java/JCEF and Node/browser bridges implement native actions separately.

## Process ownership

Editors normally own a native server per dump. Closing one must not dispose another. A crashed process can be replaced by Retry; retired messages must not overwrite new state. One-shot CLI commands load, report, and exit. Browser mode keeps a local Node host and owned servers alive until shutdown. Native MCP mode caches analyzed state in its process and uses the client's permission/model policy.

A subprocess reduces crash coupling but cannot guarantee editor responsiveness or immunity from OS-wide memory pressure. Multiple open dumps multiply resident graphs.

## Transports and trust

Native RPC uses newline-delimited JSON on stdio; stdout is protocol, stderr is diagnostics. Webviews talk through their host bridge, not directly to arbitrary native executables. Browser mode binds loopback and uses a private session URL. MCP uses initialization/tool calls, not the editor notification contract. Monitor's separate agent has additional network/security limits.

AI is a separate optional data-sharing route. Models do not need the raw dump to answer supplied context, but authorized source/tool output can reveal data. See [privacy](../ai-integration/privacy.md).

Implementation is not public distribution or platform certification. See [host availability](../getting-started/choose-host.md), [RPC](../api-reference/rpc-methods.md), and [data flow](./data-flow.md).
