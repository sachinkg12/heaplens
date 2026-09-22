/**
 * Multi-provider LLM streaming client.
 *
 * Uses Node.js built-in https/http modules — no npm dependencies.
 * API key stays in the extension process (never exposed to the webview).
 *
 * To add a new provider, add an entry to PROVIDER_REGISTRY below.
 * No other code changes are needed (Open/Closed Principle).
 */

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LlmConfig {
    provider: string;
    apiKey: string;
    baseUrl?: string;
    model?: string;
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

// ---------------------------------------------------------------------------
// Provider registry (add new providers here)
// ---------------------------------------------------------------------------

/** How to build the HTTP request and parse the SSE stream. */
type ApiFormat = 'anthropic' | 'openai-compatible';

export interface ProviderDefinition {
    /** Human-readable label shown in VS Code settings. */
    label: string;
    /** Default API base URL (user can override via heaplens.llm.baseUrl). */
    defaultBaseUrl: string;
    /** Default model name (user can override via heaplens.llm.model). */
    defaultModel: string;
    /** Which streaming format to use. */
    apiFormat: ApiFormat;
    /** Extra headers merged into every request (e.g. API-version headers). */
    extraHeaders?: Record<string, string>;
    /** Path appended to the base URL. Defaults to /v1/chat/completions (openai-compatible) or /v1/messages (anthropic). */
    chatPath?: string;
    /**
     * How to set the auth header.
     * - 'bearer'  → Authorization: Bearer <apiKey>  (default for openai-compatible)
     * - 'x-api-key' → x-api-key: <apiKey>            (default for anthropic)
     */
    authStyle?: 'bearer' | 'x-api-key';
}

export const PROVIDER_REGISTRY: Record<string, ProviderDefinition> = {
    anthropic: {
        label: 'Anthropic (Claude)',
        defaultBaseUrl: 'https://api.anthropic.com',
        defaultModel: 'claude-sonnet-4-20250514',
        apiFormat: 'anthropic',
        extraHeaders: { 'anthropic-version': '2023-06-01' },
    },
    openai: {
        label: 'OpenAI (GPT)',
        defaultBaseUrl: 'https://api.openai.com',
        defaultModel: 'gpt-4o',
        apiFormat: 'openai-compatible',
    },
    gemini: {
        label: 'Google Gemini',
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        defaultModel: 'gemini-2.0-flash',
        apiFormat: 'openai-compatible',
    },
    deepseek: {
        label: 'DeepSeek',
        defaultBaseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-chat',
        apiFormat: 'openai-compatible',
    },
    mistral: {
        label: 'Mistral',
        defaultBaseUrl: 'https://api.mistral.ai',
        defaultModel: 'mistral-large-latest',
        apiFormat: 'openai-compatible',
    },
    groq: {
        label: 'Groq',
        defaultBaseUrl: 'https://api.groq.com/openai',
        defaultModel: 'llama-3.3-70b-versatile',
        apiFormat: 'openai-compatible',
    },
    xai: {
        label: 'xAI (Grok)',
        defaultBaseUrl: 'https://api.x.ai',
        defaultModel: 'grok-3-mini',
        apiFormat: 'openai-compatible',
    },
    together: {
        label: 'Together AI',
        defaultBaseUrl: 'https://api.together.xyz',
        defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        apiFormat: 'openai-compatible',
    },
    openrouter: {
        label: 'OpenRouter',
        defaultBaseUrl: 'https://openrouter.ai/api',
        defaultModel: 'auto',
        apiFormat: 'openai-compatible',
    },
    ollama: {
        label: 'Ollama (Local)',
        defaultBaseUrl: 'http://localhost:11434',
        defaultModel: 'llama3',
        apiFormat: 'openai-compatible',
    },
};

/** All valid provider keys, for use in package.json enum and type guards. */
export const PROVIDER_IDS = Object.keys(PROVIDER_REGISTRY);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Streams an LLM response, calling callbacks for each chunk.
 */
export function streamLlmResponse(
    config: LlmConfig,
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (error: string) => void
): void {
    const providerKey = config.provider || 'anthropic';
    const provider = PROVIDER_REGISTRY[providerKey];

    if (!provider) {
        onError(`Unknown LLM provider "${providerKey}". Supported: ${PROVIDER_IDS.join(', ')}`);
        return;
    }

    if (!config.apiKey && providerKey !== 'ollama') {
        onError('No API key configured. Run "HeapLens: Set LLM API Key" from the Command Palette.');
        return;
    }

    const baseUrl = config.baseUrl || provider.defaultBaseUrl;
    const model = config.model || provider.defaultModel;
    const authStyle = provider.authStyle ?? (provider.apiFormat === 'anthropic' ? 'x-api-key' : 'bearer');

    if (provider.apiFormat === 'anthropic') {
        streamAnthropic(baseUrl, model, config.apiKey, provider, authStyle, messages, onChunk, onDone, onError);
    } else {
        streamOpenAICompatible(baseUrl, model, config.apiKey, provider, authStyle, messages, onChunk, onDone, onError);
    }
}

// ---------------------------------------------------------------------------
// Streaming implementations
// ---------------------------------------------------------------------------

function streamAnthropic(
    baseUrl: string,
    model: string,
    apiKey: string,
    provider: ProviderDefinition,
    authStyle: 'bearer' | 'x-api-key',
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (error: string) => void
): void {
    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    const body = JSON.stringify({
        model,
        max_tokens: 4096,
        stream: true,
        system: systemMessages.map(m => m.content).join('\n\n') || undefined,
        messages: conversationMessages.map(m => ({
            role: m.role,
            content: m.content
        }))
    });

    const chatPath = provider.chatPath || '/v1/messages';
    const url = new URL(`${baseUrl}${chatPath}`);
    const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...buildAuthHeader(authStyle, apiKey),
        ...(provider.extraHeaders || {}),
    };

    makeStreamingRequest(url, headers, body, 'Anthropic', (data) => {
        const event = JSON.parse(data);
        if (event.type === 'content_block_delta' && event.delta?.text) {
            onChunk(event.delta.text);
        }
    }, onDone, onError);
}

function streamOpenAICompatible(
    baseUrl: string,
    model: string,
    apiKey: string,
    provider: ProviderDefinition,
    authStyle: 'bearer' | 'x-api-key',
    messages: ChatMessage[],
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (error: string) => void
): void {
    const body = JSON.stringify({
        model,
        stream: true,
        messages: messages.map(m => ({
            role: m.role,
            content: m.content
        }))
    });

    const chatPath = provider.chatPath || '/v1/chat/completions';
    const url = new URL(`${baseUrl}${chatPath}`);
    const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? buildAuthHeader(authStyle, apiKey) : {}),
        ...(provider.extraHeaders || {}),
    };

    makeStreamingRequest(url, headers, body, provider.label, (data) => {
        const event = JSON.parse(data);
        const content = event.choices?.[0]?.delta?.content;
        if (content) {
            onChunk(content);
        }
    }, onDone, onError);
}

/**
 * Non-streaming wrapper: accumulates all chunks and resolves with the full response.
 */
export function callLlmFull(config: LlmConfig, messages: ChatMessage[]): Promise<string> {
    return new Promise((resolve, reject) => {
        let result = '';
        streamLlmResponse(
            config,
            messages,
            (chunk) => { result += chunk; },
            () => { resolve(result); },
            (error) => { reject(new Error(error)); }
        );
    });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildAuthHeader(style: 'bearer' | 'x-api-key', apiKey: string): Record<string, string> {
    if (style === 'x-api-key') {
        return { 'x-api-key': apiKey };
    }
    return { 'Authorization': `Bearer ${apiKey}` };
}

/**
 * Returns actionable HTTP guidance without forwarding an untrusted provider
 * response body. Providers may echo rejected credentials or other sensitive
 * request data in that body, so it must never reach HeapLens UI or logs.
 */
export function formatProviderHttpError(providerLabel: string, statusCode: number): string {
    const prefix = `${providerLabel} API error (${statusCode}):`;

    if (statusCode === 401) {
        return `${prefix} Authentication failed. Verify the configured API key.`;
    }
    if (statusCode === 403) {
        return `${prefix} Access denied. Verify the API key permissions and account access.`;
    }
    if (statusCode === 404) {
        return `${prefix} Endpoint or model not found. Check the provider, model, and base URL settings.`;
    }
    if (statusCode === 429) {
        return `${prefix} Rate limit exceeded. Wait and retry, or check the provider quota.`;
    }
    if (statusCode >= 500) {
        return `${prefix} The provider service failed. Retry later or check its status page.`;
    }
    return `${prefix} Request rejected. Check the provider, model, and base URL settings.`;
}

/**
 * Shared SSE streaming over HTTP(S). Both API formats use the same
 * transport — only the JSON parsing callback differs.
 */
function makeStreamingRequest(
    url: URL,
    headers: Record<string, string | number>,
    body: string,
    providerLabel: string,
    onSseData: (data: string) => void,
    onDone: () => void,
    onError: (error: string) => void
): void {
    const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
    };

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 400) {
            const safeError = formatProviderHttpError(providerLabel, res.statusCode);
            // Drain without retaining the body. It is provider-controlled and
            // may contain an echoed API key or other sensitive request data.
            res.resume();
            res.on('end', () => {
                onError(safeError);
            });
            return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6).trim();
                    if (data === '[DONE]') { continue; }
                    try {
                        onSseData(data);
                    } catch {
                        // Skip malformed SSE lines
                    }
                }
            }
        });

        res.on('end', () => { onDone(); });
    });

    req.on('error', (err) => {
        onError(`Request failed: ${err.message}`);
    });

    req.write(body);
    req.end();
}
