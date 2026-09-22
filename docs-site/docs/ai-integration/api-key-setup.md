---
sidebar_position: 2
title: "API Key Setup"
---

# API Key Setup (Direct LLM)

This approach uses your own provider API key to power the AI Chat tab, Explain Object, and Explain Leak Suspect features directly within the HeapLens editor.

## Configuration

Open VS Code Settings (`Cmd+,` on macOS, `Ctrl+,` on Windows/Linux), search for `heaplens.llm`, and select a provider. Then run **HeapLens: Set or Replace LLM API Key** from the Command Palette. Use the eye button only while entering the key if you need to verify it. The key is stored in the editor's encrypted VS Code SecretStorage implementation, separately for each provider, and is not synchronized between machines or editor applications.

Run **HeapLens: Show LLM API Key Status** to check whether the selected provider has a key. The status displays only a fixed mask plus the last four characters when the key is long enough. HeapLens never reveals a saved key in full. Use **Replace** or **Clear** from the status notification when needed.

| Setting | Required | Description | Example |
|---------|----------|-------------|---------|
| `heaplens.llm.provider` | Yes | LLM provider | `"anthropic"` or `"openai"` |
| `heaplens.llm.baseUrl` | No | Custom API endpoint for proxies or local models | `"https://my-proxy.example.com"` |
| `heaplens.llm.model` | No | Override the default model | `"claude-sonnet-4-20250514"` |

### Default Models

| Provider | Default Model |
|----------|---------------|
| Anthropic | Claude Sonnet 4 (`claude-sonnet-4-20250514`) |
| OpenAI | GPT-4o (`gpt-4o`) |

If you set `heaplens.llm.model`, that value is used regardless of provider.

### Using a Proxy or Local Model

Set `heaplens.llm.baseUrl` to route API calls through a corporate proxy or to a local model server (e.g., LiteLLM, Ollama with OpenAI-compatible API):

```json
{
  "heaplens.llm.provider": "openai",
  "heaplens.llm.baseUrl": "http://localhost:11434/v1",
  "heaplens.llm.model": "llama3.1"
}
```

If that endpoint requires a token, store it with **HeapLens: Set or Replace LLM API Key**. For Ollama without authentication, select the `ollama` provider and no key is required.

## Features Enabled

### 1. AI Chat Tab

A full chat interface inside the HeapLens editor. On your first message, the analysis summary (~2-3K tokens) is injected as context so the LLM knows about your specific heap dump.

- Streaming responses (token-by-token)
- Conversation history (up to 20 exchanges per editor)
- Works with any question about the heap dump

See [AI Chat Tab](../tabs-guide/ai-chat-tab) for details.

### 2. Explain Object

In the Dominator Tree, click the magnifying glass on any object to open the Object Inspector, then click **"Explain this object"**. HeapLens sends the object's class name, field values, sizes, and GC root path to the LLM and streams back a structured explanation with a severity rating and code fix example.

See [Object Inspector & Explain](../tabs-guide/object-inspector) for details.

### 3. Explain Leak Suspect

On the Leak Suspects tab, each suspect card has an **"Explain"** link. Click it to get an inline AI explanation of why this class is a leak suspect, common root causes, and a before/after Java code fix.

## How It Works

```
User clicks "Explain" or sends chat message
        │
        ▼
Extension reads non-secret heaplens.llm.* settings
and the provider key from VS Code SecretStorage
        │
        ▼
Builds prompt (promptTemplates.ts)
  + heap context (analysisContext.ts)
        │
        ▼
HTTPS request to Anthropic/OpenAI API
  (streaming, via llmClient.ts)
        │
        ▼
Tokens streamed to webview in real-time
        │
        ▼
Final response rendered as formatted Markdown
```

The extension makes direct HTTPS calls using Node.js built-in `https` module — no additional npm dependencies required.

## Error Handling

| Error | What You See | Fix |
|-------|-------------|-----|
| No API key configured | "No API key configured" error in explain area | Run **HeapLens: Set or Replace LLM API Key** |
| Invalid API key | "401 Unauthorized" error | Verify key is correct and has not expired |
| Rate limit exceeded | "429 Too Many Requests" error | Wait and retry, or switch to a different model |
| Network error | Connection timeout message | Check internet connection and `baseUrl` setting |

## Cost Considerations

Each interaction sends ~2-3K tokens of heap context plus your question. A typical Explain Object response is ~800-1200 tokens. At current API pricing:

- **Anthropic Claude Sonnet 4:** ~$0.01-0.02 per explain/chat message
- **OpenAI GPT-4o:** ~$0.01-0.03 per explain/chat message

The context is included once per conversation in chat mode (not repeated with every message).
