---
sidebar_position: 2
title: Configure providers, models, and keys
---

## VS Code

1. Select `heaplens.llm.provider` in settings.
2. Run **HeapLens: Set or Replace LLM API Key** from the Command Palette. Enter the credential in the masked input; use the visibility control to check it locally.
3. Optionally set `heaplens.llm.model` and `heaplens.llm.baseUrl`.
4. Run **HeapLens: Show LLM API Key Status**, then try one non-sensitive question.

Credentials use the editor's **SecretStorage**, not ordinary settings or Settings Sync. Non-secret provider/model/endpoint options remain settings. **Clear LLM API Key** removes the selected provider's stored credential. On activation, legacy explicit `heaplens.llm.apiKey` values migrate to secret storage and are removed from configuration scopes; inspect old backups/committed settings separately because migration cannot erase historical copies.

Ollama normally needs no key. A proxy can have its own authentication requirements.

## Ten presets and custom model IDs

| Setting ID | Provider |
| --- | --- |
| `anthropic` | Anthropic (Claude) |
| `openai` | OpenAI |
| `gemini` | Google Gemini via compatible endpoint |
| `deepseek` | DeepSeek |
| `mistral` | Mistral |
| `groq` | Groq |
| `xai` | xAI |
| `together` | Together AI |
| `openrouter` | OpenRouter |
| `ollama` | Ollama |

Preset defaults are convenience values, **not a live catalog of the latest models**. Enter the exact model identifier your provider/account supports. A new model needs no HeapLens release if it accepts the implemented Anthropic or OpenAI-compatible streaming request format. A new protocol or unsupported feature can require an adapter change. Automatic model discovery is not promised.

An example non-secret configuration:

```json
{
  "heaplens.llm.provider": "ollama",
  "heaplens.llm.model": "your-installed-model",
  "heaplens.llm.baseUrl": "http://localhost:11434"
}
```

Check endpoint compatibility and policy. Fix with AI rejects malformed/non-HTTP(S) destinations and embedded credentials, queries, or fragments; authentication belongs in the credential flow. Do not put API keys in URLs.

## IntelliJ and standalone browser

IntelliJ uses **Configure AI** and its password-safe adapter. The browser uses its configuration dialog and in-memory credentials for the running host session, not an OS vault. Source and session approvals are distinct from telemetry. See [privacy](./privacy.md) for host-specific lifetime.

## Errors, costs, and disclosure

A 401 can mean a wrong/expired credential; 403 can mean permission; 429 can mean limits; unsupported models/endpoints can produce other failures. Error displays should not reveal credential contents. Do not post raw provider errors or private URLs in public issues.

Costs depend on provider/model, supplied context, history, source size, and output. Check your provider's current billing and data-use policy; there is no fixed per-question cost guarantee. Local endpoints can forward remotely.
