---
sidebar_position: 1
title: Choose an AI route
---

import FlowDiagram from '@site/src/components/FlowDiagram';

AI is optional. Parsing, HeapQL, root paths, and exports work without a model or API key. Choose a route based on the host and **what leaves your machine**, not only the provider name.

<FlowDiagram kind="ai" />

| Route | Model configuration | Data boundary |
| --- | --- | --- |
| Built-in AI Chat / Explain / Fix | Ten direct-provider presets, editable model ID and compatible endpoint | Host constructs minimized metadata prompts; approved source is sent in full |
| VS Code chat participant | Editor language-model API; request-selected model | Explicit approval for each bounded question; generation-scoped history and evidence |
| MCP client / coding agent | Client selects and runs the model | Exact-file and metadata approval at launch; six metadata-only tools, with no unrestricted query/raw-value fallback |

The ten presets are Anthropic, OpenAI, Gemini, DeepSeek, Mistral, Groq, xAI, Together AI, OpenRouter, and Ollama. The chat participant is a separate integration, not an eleventh direct-provider preset. Local Ollama is keyless by default; other presets require configured credentials.

## Shared analysis, separate AI behavior

Direct-AI adapters exist for VS Code, IntelliJ, and the standalone browser. Chat accepts ordinary conversation, follow-ups and HeapQL help; it does not require a JSON answer. Supported default model/endpoint profiles can request bounded native `heap_read` calls. Unrecognized models or endpoints retain text chat from the approved summary; Explain can still include the selected object's engine metadata. There is no hidden provider switch or automatic retry. These changes are not automatically present in older published packages. See [hosts](../getting-started/choose-host.md).

Tool names, arguments, exact object identities, scope and output projections are checked by the host. Evidence buttons open actual engine records. AI prose is interpretation, not mechanically verified facts or a verified repair. Queries remain suggestions until you explicitly run them. Credential storage and source-proposal controls remain host-specific. External MCP clients decide how approved metadata enters their prompts; their prose does not pass through the built-in answer renderer.

## What AI can help with

Ask for an interpretation of a suspect, propose a bounded HeapQL investigation, or request a project-source proposal. The model sees only the supplied context, not automatically every object or every source file. It can hallucinate queries, misinterpret ownership, or suggest unsafe Java changes.

Verify queries, retaining paths, lifecycle assumptions, and tests. A larger model can answer differently from a smaller one; identical heap bytes do not establish identical prompts or responses.

Start with [configuration](./api-key-setup.md), read [privacy](./privacy.md), then use [AI Chat](../tabs-guide/ai-chat-tab.md), [Explain](../tabs-guide/object-inspector.md), or [Source](../tabs-guide/source-tab.md).
