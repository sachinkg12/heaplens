---
sidebar_position: 4
title: AI data sharing and privacy
---

Policy scope: updated local implementation; verify your installed package's behavior before sharing sensitive data. Analysis is local; **AI requests are optional but can send data to a model service**. Telemetry has a [separate policy](../runbook/telemetry.md).

For IntelliJ IDEA, see the [HeapLens IntelliJ Privacy Policy](../runbook/intellij-privacy-policy.md), including local storage, Azure retention, IP handling, and the privacy contact.

## What can be sent?

| Action | Supplied information | Important limit |
| --- | --- | --- |
| AI Chat / participant context | Exact summary/counts/sizes/IDs, class/field names/types and bounded reference/root-path metadata | Explicit approval; at most four model calls and three reads per question; typed text/history is not anonymized |
| Explain | Object/field names and types, sizes, reference metadata | Primitive contents and duplicate-string previews are omitted from minimized prompts |
| Fix with AI | Approved **entire source file** plus relevant analysis/context | No automatic redaction; the local absolute source path is omitted from the prompt |
| MCP tools | Approved metadata only; no raw primitive/string contents, source or local paths | Human launch configuration approves exact files and sharing; external client controls forwarding and model reasoning |

Counts and names can still be identifying. Local Waste/Inspector data, copied incident reports, downloads, and exports keep their full local information. Do not assume a report is safe to share because AI prompts are minimized.

## Approval and credentials differ by host

| Host | Credentials | Approval / history |
| --- | --- | --- |
| VS Code | SecretStorage, not ordinary settings/sync | Fresh source approval per Fix request; editor-specific chat history/state |
| IntelliJ | Password-safe adapter | Chat session approval is separate from full-source confirmation; local persisted preferences/history follow the adapter |
| Standalone browser | In-memory running-host session | Session controls plus explicit full-source confirmation; no persistent OS credential vault |
| Participant | Editor language-model API | Explicit approval per question to the request's selected model; only scoped completed conversation snapshots can be reused |
| MCP | Configured client | Exact-file launch approval plus metadata flag; client owns model destination, retention and upload policy |

For source submission, check the **actual configured destination** and whole-file disclosure. Send Source approves that request. Review Source opens locally and cancels transmission. Cancel, Escape, or dismissal sends nothing. Approved code is sent in full; do not approve a file containing secrets you cannot disclose. Provider changes during confirmation must not redirect an already approved source request.

A loopback endpoint may forward requests remotely. “Local Ollama” or localhost is not evidence that processing remains on your machine.

## Context and correctness limits

Built-in Chat accepts natural-language replies. Native engine reads and evidence handles are validated independently of the answer's wording. Evidence buttons contain actual scoped engine metadata; AI prose, numerical interpretations, possible causes and proposed repairs are not mechanically verified. Do not treat an evidence link as proof of a causal explanation. Completed context is bound to the analysis and destination. Restored display-only text is not forwarded into a new investigation. Stop, Clear, Retry, settings/credential changes and closing the originating view revoke active work and approval. Already transmitted information cannot be recalled.

Top-N metadata cannot reveal unprovided objects, lifecycle intent, allocation history, or whether a proposed repair is semantically correct. Review proposals, tests, and resulting captures. Do not rely on generic resource-closing advice to release retained buffers.

## Handling shared data

Your configured service/client's retention, training, logging, account policy, and jurisdiction apply to transmitted data. HeapLens does not certify those policies. Disabling telemetry does not disable AI, and approving telemetry does not approve source upload.

Keep credentials out of settings JSON, Git, command lines, screenshots, and logs. Review local reports before support sharing. For security reports use [support and security](../runbook/support.md), without attaching dumps or source publicly.

## Local structural caches

Optional **Disk-backed references** persist private local structural indexes. These can contain HPROF metadata strings, class/field names, object identifiers, modeled sizes, array lengths, byte locations, reference relationships, component checksums and a full-content fingerprint of the capture. They do not store raw primitive-array buffers or duplicate-string previews. They are not encrypted or automatically uploaded by index construction; the original capture is still required.

Completed indexes remain in the analysis host's platform cache directory for reuse, including on a remote extension host. Memory storage is the default and does not create these reusable indexes. Switching back to Memory does not delete existing indexes. Close all analyses using an entry before removing it; never modify a mapped index or capture. See [cache locations and cleanup](../api-reference/cli.md#disk-reference-storage).

Resource admission also uses local coordination files containing reservation counts; these are not a copy of the dump. Index storage and resource coordination do not authorize AI requests or change telemetry permissions.
