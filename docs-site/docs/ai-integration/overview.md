---
sidebar_position: 1
title: "Overview"
---

# AI Integration

HeapLens provides three distinct ways to bring AI-powered analysis to your heap dumps. Each approach serves a different workflow — choose the one that fits how you work, or combine them.

## The Three Approaches

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐  │
│  │  MCP Server      │   │  API Key         │   │  @heaplens      │  │
│  │  (Layer 1)       │   │  (Layer 2)       │   │  (Layer 3)      │  │
│  │                  │   │                  │   │                  │  │
│  │  Claude Desktop  │   │  Built-in Chat   │   │  Copilot Chat   │  │
│  │  Cline           │   │  Explain Button  │   │  Cline Chat     │  │
│  │  Any MCP Client  │   │  Leak Explain    │   │  Claude Dev     │  │
│  │                  │   │                  │   │                  │  │
│  │  hprof-server    │   │  Anthropic /     │   │  VS Code LM API │  │
│  │  --mcp           │   │  OpenAI API      │   │  (auto)         │  │
│  └────────┬─────────┘   └────────┬─────────┘   └────────┬─────────┘  │
│           │                      │                       │           │
│           └──────────────┬───────┴───────────────────────┘           │
│                          │                                           │
│                   ┌──────┴──────┐                                    │
│                   │ Rust Engine │                                    │
│                   │  (lib.rs)   │                                    │
│                   └─────────────┘                                    │
└─────────────────────────────────────────────────────────────────────┘
```

All three approaches share the same Rust analysis engine and the same prompt templates. The difference is **where the LLM runs** and **how you interact with it**.

## Quick Comparison

| | MCP Server | API Key (Direct) | Chat Participant (@heaplens) |
|---|---|---|---|
| **Setup** | Configure `claude_desktop_config.json` | Store API key with the HeapLens Command Palette command | Install Copilot/Cline/Claude Dev |
| **Requires API key** | No | Yes (Anthropic or OpenAI) | No (uses host extension's auth) |
| **Works outside VS Code** | Yes | No | No |
| **Streaming responses** | No (synchronous) | Yes | Yes |
| **Interactive drill-down** | Yes (via tool calls) | Limited (top objects only) | Limited (top objects only) |
| **Conversation history** | Managed by client | 20 exchanges per editor | Managed by host extension |
| **Best for** | Automation, CI/CD, desktop AI | IDE-integrated analysis | Seamless Copilot/Cline workflow |

## Which Should I Use?

**"I use Claude Desktop / Cline / Cursor"** → [MCP Server](../mcp/introduction)
Your AI client calls HeapLens tools directly. No API key needed — the client handles the LLM. Best for conversational, multi-step investigations.

**"I want analysis inside the HeapLens editor"** → [API Key (Direct)](./api-key-setup)
The AI Chat tab and Explain buttons live inside the HeapLens custom editor. You need your own Anthropic or OpenAI API key. Best for quick, contextual explanations while browsing the heap.

**"I already have GitHub Copilot"** → [Chat Participant (@heaplens)](./chat-participant)
Type `@heaplens` in the Copilot Chat panel. No extra setup — works automatically if Copilot is installed. Best for teams already using Copilot.

## Features by Approach

### AI Chat (all approaches)

Ask natural-language questions about your heap dump:
- *"What is the biggest memory consumer?"*
- *"Is there a memory leak? What evidence supports that?"*
- *"What are the top 3 things I should fix?"*

### Explain Object (API Key only)

Click "Explain this object" in the Object Inspector panel to get:
- What the object is and its purpose
- Why it's a memory concern
- Retention chain analysis
- Before/after Java code fix example
- Severity classification

### Explain Leak Suspect (API Key only)

Click "Explain" on any leak suspect card to get an inline AI explanation with fix recommendations.

### Tool-Based Drill-Down (MCP only)

MCP clients can call individual tools (`drill_down`, `get_class_histogram`, etc.) for targeted investigation. This enables multi-step conversations where the AI explores the heap interactively.
