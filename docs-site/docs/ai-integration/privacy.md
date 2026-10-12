---
sidebar_position: 4
title: AI data sharing and privacy
---

Policy scope: current editor/browser implementation, reviewed October 11, 2026. Analysis is local; **AI requests are optional but can send data to a model service**. Telemetry has a [separate policy](../runbook/telemetry.md).

For IntelliJ IDEA, see the [HeapLens IntelliJ Privacy Policy](../runbook/intellij-privacy-policy.md), including local storage, Azure retention, IP handling, and the privacy contact.

## What can be sent?

| Action | Supplied information | Important limit |
| --- | --- | --- |
| AI Chat / participant context | Summary, counts/sizes, class names, leak descriptions, reference/path metadata | Bounded selections, not all objects; typed text/history is not anonymized |
| Explain | Object/field names and types, sizes, reference metadata | Primitive contents and duplicate-string previews are omitted from minimized prompts |
| Fix with AI | Approved **entire source file** plus relevant analysis/context | No automatic redaction; the local absolute source path is omitted from the prompt |
| MCP tools | Tool-specific analysis data, potentially previews and primitive values | Editor prompt minimization does **not** filter tool results |

Counts and names can still be identifying. Local Waste/Inspector data, copied incident reports, downloads, and exports keep their full local information. Do not assume a report is safe to share because AI prompts are minimized.

## Approval and credentials differ by host

| Host | Credentials | Approval / history |
| --- | --- | --- |
| VS Code | SecretStorage, not ordinary settings/sync | Fresh source approval per Fix request; editor-specific chat history/state |
| IntelliJ | Password-safe adapter | Chat session approval is separate from full-source confirmation; local persisted preferences/history follow the adapter |
| Standalone browser | In-memory running-host session | Session controls plus explicit full-source confirmation; no persistent OS credential vault |
| Participant | Editor language-model API | Current code prefers GPT-4o/fallback-first, not guaranteed editor-selected model |
| MCP | Configured client | Client owns model/tool permissions, prompting, retention, and upload policy |

For source submission, check the **actual configured destination** and whole-file disclosure. Send Source approves that request. Review Source opens locally and cancels transmission. Cancel, Escape, or dismissal sends nothing. Approved code is sent in full; do not approve a file containing secrets you cannot disclose. Provider changes during confirmation must not redirect an already approved source request.

A loopback endpoint may forward requests remotely. “Local Ollama” or localhost is not evidence that processing remains on your machine.

## Context and correctness limits

Model responses are hypotheses, not verified diagnoses. Current VS Code follow-up history does not reliably preserve the initially injected heap context: ask with explicit bounded evidence and verify against the UI/query. Different hosts/models can construct different requests and produce different answers.

Top-N metadata cannot reveal unprovided objects, lifecycle intent, allocation history, or whether a proposed repair is semantically correct. Review proposals, tests, and resulting captures. Do not rely on generic resource-closing advice to release retained buffers.

## Handling shared data

Your configured service/client's retention, training, logging, account policy, and jurisdiction apply to transmitted data. HeapLens does not certify those policies. Disabling telemetry does not disable AI, and approving telemetry does not approve source upload.

Keep credentials out of settings JSON, Git, command lines, screenshots, and logs. Review local reports before support sharing. For security reports use [support and security](../runbook/support.md), without attaching dumps or source publicly.
