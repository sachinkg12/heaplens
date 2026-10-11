---
sidebar_position: 3
title: Renderers and host bridges
---

The VS Code frontend owns extension activation, custom-editor lifecycle, RPC connections, and native editor actions. Shared webview renderers do not own secret storage or arbitrary filesystem access.

## Modules and contracts

| Area | Responsibility |
| --- | --- |
| extension / hprofEditorProvider | Activation, open dump, per-editor process/session |
| rustClient / connection/session services | Requests, notifications, failure/recovery routing |
| message/feature handlers | Validate action messages and call host services |
| webview template and view renderers | Eleven views, tables, charts, object panels |
| source services | Workspace/dependency resolution and native navigation |
| llm configuration/credential/consent services | Model options, host secret storage, explicit sharing |
| telemetry adapters | Versioned allowlist and host preference/delivery |

The IntelliJ adapter provides Java/JCEF/native services; standalone provides Node/browser services. Their boundary contracts permit adding a host without turning the VS Code extension into a universal host class.

## Assets and browser execution

VS Code loads **packaged** `media/d3.v7.min.js`, not a public CDN. Local assets and content-security rules determine script loading. Generated scripts use escaped/untrusted heap names rather than treating names or model output as code.

Theme tokens adapt to the host; remote assets do not need to be fetched just to draw a chart. Diagram assets on this documentation site are illustrative, separate from the product renderer.

## Requests and recovery

A normal request timeout is not a full analysis deadline. Analysis acknowledgement/progress/completion are separate. Session generations prevent old process responses from replacing a new analysis. UI actions must reconnect after Retry.

## AI and source

The webview sends action requests, not stored API keys. Credential backends and full-file approval remain host-owned. Class matching is not guaranteed source coverage, and prompts/history differ by host. See [Source](../tabs-guide/source-tab.md), [AI privacy](../ai-integration/privacy.md), and [debugging](../runbook/debugging-webview.md).
