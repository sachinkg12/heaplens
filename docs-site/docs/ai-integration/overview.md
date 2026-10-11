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
| VS Code chat participant | Editor language-model API; current code prefers GPT-4o then first available fallback | Separate editor/model entitlement and disclosure |
| MCP client / coding agent | Client selects and runs the model | Tool data is returned to the client; editor prompt filtering does not apply |

The ten presets are Anthropic, OpenAI, Gemini, DeepSeek, Mistral, Groq, xAI, Together AI, OpenRouter, and Ollama. The chat participant is a separate integration, not an eleventh direct-provider preset. Local Ollama is keyless by default; other presets require configured credentials.

## Shared analysis, separate AI behavior

Direct-AI adapters exist for VS Code, IntelliJ, and the standalone browser. Their public/candidate availability differs; see [hosts](../getting-started/choose-host.md). Credential storage, history, approvals, and proposal controls are host-specific. MCP does not reuse editor prompt templates: the client decides how raw tool results enter prompts.

## What AI can help with

Ask for an interpretation of a suspect, propose a bounded HeapQL investigation, or request a project-source proposal. The model sees only the supplied context, not automatically every object or every source file. It can hallucinate queries, misinterpret ownership, or suggest unsafe Java changes.

Verify queries, retaining paths, lifecycle assumptions, and tests. A larger model can answer differently from a smaller one; identical heap bytes do not establish identical prompts or responses.

Start with [configuration](./api-key-setup.md), read [privacy](./privacy.md), then use [AI Chat](../tabs-guide/ai-chat-tab.md), [Explain](../tabs-guide/object-inspector.md), or [Source](../tabs-guide/source-tab.md).
