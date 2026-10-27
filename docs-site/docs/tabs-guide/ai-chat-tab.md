---
sidebar_position: 11
title: AI Chat
---

Configure a provider, choose a model ID, then ask a question. Stop cancels the active stream; Clear clears the visible chat according to host controls. Approval/configuration and history lifetime differ by host.

Chat is scoped to HeapLens, Java/JVM memory analysis and HeapQL. Brief greetings and relevant follow-ups are supported; unrelated requests should receive a short redirect. These are shared model instructions, not a guarantee that every provider will follow them.

## Useful questions

- Which large objects should I inspect, and which assumptions remain unknown?
- Give a bounded HeapQL query to find the largest instances.
- Explain the difference between storage type and retaining owner.

Minimized prompts include summary/counts/sizes, class/field names, descriptions, and reference metadata, **not raw duplicate-string previews or primitive contents**. User-entered text/history is not redacted. Top-N context is incomplete.

## Verify the response

Chat shows **Run Query** for recognized HeapQL suggestions: `heapql` or `sql` code blocks (case-insensitive), untagged code blocks, standalone query paragraphs and inline query snippets. Inspection commands such as `:info 42` are also supported. The preferred model output is one query per `heapql` block. A single trailing SQL-style semicolon is removed because it is not a HeapQL token; quoted literal contents are preserved. Recognition is a presentation aid, not a guarantee that a query is valid. Shell/Java code and multiple statements do not receive runnable controls.

Displaying an answer never executes a query. Review its syntax and bounds, then click **Run Query** to run it locally against the current dump. Results appear beneath that suggestion and are not automatically sent to the AI provider. An error allows another explicit attempt; Retry/reloading the dump expires the old controls. **See full results in Query tab** starts that query only when clicked. Queries are read-only but can be costly. AI can propose unsupported syntax, double-count retained totals, or confuse resource closure with releasing buffers.

Same dump does not imply same answer: model, prompt/context, history, and provider settings can differ. Each current Chat turn includes bounded analysis metadata and only completed, destination-scoped history. Ordinary replies do not need JSON. Evidence buttons appear only for records cited in that reply, not for all metadata available to the model. Greetings, refusals and general explanations should have no heap-evidence attachments. A valid citation does not establish that the record supports the interpretation. Check quantities, ownership and any proposed query against the UI and query results.

## Session and sharing

IntelliJ/browser session approval is distinct from full-source confirmation. VS Code source submission asks per Fix request. History storage/export is host-specific, not a universal durable memory feature. Credentials use SecretStorage/password-safe/session memory respectively.

Do not type secrets. Local endpoints may forward remotely. See [provider setup](../ai-integration/api-key-setup.md), [privacy](../ai-integration/privacy.md), and [Source](./source-tab.md) before Fix with AI.
