---
sidebar_position: 5
title: "AI Data Sharing & Privacy"
---

# AI Data Sharing & Privacy

Heap analysis runs locally. Using AI sends selected information to a model provider or AI client. A summary is not necessarily non-sensitive, and storing API keys securely does not anonymize prompt contents.

## Editor AI Chat, Explain, and Copilot

HeapLens automatically supplies summary counts and sizes, class/field names, leak descriptions, and reference-path metadata as appropriate. Duplicate-string contents and primitive field values are omitted from these prompts. The local Waste tab, Object Inspector, and copied incident report still contain their normal data.

Class/field names and dependency coordinates can identify internal systems. Messages you type and conversation history are sent as entered, not automatically redacted. Do not paste credentials, customer information, or code you are not authorized to share. Copilot uses the editor-selected model and that provider's policies, not the direct HeapLens API configuration.

## Fix with AI

Each request asks **Send the entire source file … for an AI fix?** The modal names the configured endpoint's origin, including custom URLs, and explains the data being shared.

- **Send Source** approves that request only. HeapLens sends the complete resolved source file and minimized heap context.
- **Review Source** opens the resolved file locally and cancels this request. Run Fix with AI again after reviewing it.
- **Cancel**, Escape, or dismissal sends nothing.

The prompt does not add the local absolute file path. It does not redact the approved source: comments, credentials, paths, and other sensitive contents inside the file will be sent. The existing diff review/save workflow is unchanged; approving transmission does not automatically apply a fix.

The consent applies to all providers, including Ollama. A local endpoint or proxy can forward to a remote service, so neither the provider name nor a loopback URL proves local-only model processing. Confirm your endpoint's operation and retention policy. AI Fix rejects malformed/non-HTTP(S) endpoints and URLs containing credentials, queries or fragments; use the secure API key command for authentication.

## MCP is a separate boundary

The standalone MCP server is not covered by the editor's source-consent modal or prompt minimization. Its analysis/waste tool output can include string previews, and query tools can expose additional heap data. An MCP client may forward tool results to its model. Only connect authorized clients to dumps you are allowed to share. MCP output minimization/consent is tracked separately; do not assume all HeapLens-to-AI paths are sanitized.

## Existing data

This change prevents the automatic disclosures described above in new editor prompts. It cannot recall previous provider requests, erase remote logs, or scrub secrets you previously typed into a conversation. Clear old chats and review provider retention controls when relevant.
