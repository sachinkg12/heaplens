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
import { AiMessage, AiReply, ToolCallCollector, wireMessages, wireTools } from './aiToolProtocol';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LlmConfig {
    provider: string;
    apiKey: string;
    baseUrl?: string;
    model?: string;
}

export type ChatMessage = AiMessage;

export interface LlmRequestOptions {
    signal?: AbortSignal;
    /** Tests may shorten this; production requests always have a finite deadline. */
    timeoutMs?: number;
    /** Optional transport hint; investigation validation never depends on it. */
    responseFormat?: 'json_object';
    tools?: boolean;
    onTools?: (calls: AiReply['toolCalls']) => void;
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
    /** Documented JSON-object support for this preset's default origin/model, not arbitrary overrides. */
    jsonObjectOutput?: boolean;
    /** Native tool support for this preset's default endpoint/model, not arbitrary overrides. */
    toolCalls?: boolean;
}

export const PROVIDER_REGISTRY: Record<string, ProviderDefinition> = {
    anthropic: {
        label: 'Anthropic (Claude)',
        defaultBaseUrl: 'https://api.anthropic.com',
        defaultModel: 'claude-sonnet-4-20250514',
        toolCalls: true,
        apiFormat: 'anthropic',
        extraHeaders: { 'anthropic-version': '2023-06-01' },
    },
    openai: {
        label: 'OpenAI (GPT)',
        defaultBaseUrl: 'https://api.openai.com',
        defaultModel: 'gpt-4o',
        toolCalls: true,
        apiFormat: 'openai-compatible',
        jsonObjectOutput: true,
    },
    gemini: {
        label: 'Google Gemini',
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        defaultModel: 'gemini-2.0-flash',
        toolCalls: true,
        apiFormat: 'openai-compatible',
    },
    deepseek: {
        label: 'DeepSeek',
        defaultBaseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-chat',
        toolCalls: true,
        apiFormat: 'openai-compatible',
    },
    mistral: {
        label: 'Mistral',
        defaultBaseUrl: 'https://api.mistral.ai',
        defaultModel: 'mistral-large-latest',
        toolCalls: true,
        apiFormat: 'openai-compatible',
    },
    groq: {
        label: 'Groq',
        defaultBaseUrl: 'https://api.groq.com/openai',
        defaultModel: 'llama-3.3-70b-versatile',
        toolCalls: true,
        apiFormat: 'openai-compatible',
    },
    xai: {
        label: 'xAI (Grok)',
        defaultBaseUrl: 'https://api.x.ai',
        defaultModel: 'grok-3-mini',
        toolCalls: true,
        apiFormat: 'openai-compatible',
    },
    together: {
        label: 'Together AI',
        defaultBaseUrl: 'https://api.together.xyz',
        defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        toolCalls: true,
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
    onError: (error: string) => void,
    options: LlmRequestOptions = {}
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

    try {
        const endpoint = new URL(baseUrl);
        if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
            || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:'
                && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
            onError('Use an HTTPS AI endpoint, or HTTP loopback, without URL credentials/query/fragment.');
            return;
        }
        const safeChunk = (text: string) => onChunk(text);
        if (provider.apiFormat === 'anthropic') {
            streamAnthropic(baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''), model, config.apiKey, provider, authStyle, messages, safeChunk, onDone, onError, options);
        } else {
            // An override may already include /v1 (or another provider-specific API prefix).
            streamOpenAICompatible(baseUrl.replace(/\/+$/, ''), model, config.apiKey, provider, authStyle, messages, safeChunk, onDone, onError, options);
        }
    } catch {
        onError('AI endpoint or request configuration is invalid. Check provider, model and base URL.');
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
    onError: (error: string) => void,
    options: LlmRequestOptions
): void {
    const systemMessages = messages.filter(m => m.role === 'system');
    const conversationMessages = messages.filter(m => m.role !== 'system');

    const body = JSON.stringify({
        model,
        max_tokens: 4096,
        stream: true,
        system: systemMessages.map(m => m.content).join('\n\n') || undefined,
        messages: wireMessages(conversationMessages,true),
        ...wireTools(true,options.tools===true)
    });

    const chatPath = provider.chatPath || '/v1/messages';
    const url = new URL(`${baseUrl}${chatPath}`);
    const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...buildAuthHeader(authStyle, apiKey),
        ...(provider.extraHeaders || {}),
    };

    const tools=new ToolCallCollector();
    makeStreamingRequest(url, headers, body, 'Anthropic', (data) => {
        const event = JSON.parse(data);
        tools.consume(event,true);
        if (event.type === 'content_block_delta' && event.delta?.text) {
            onChunk(event.delta.text);
        }
    }, () => {try{options.onTools?.(tools.finish());onDone();}catch{onError('AI returned malformed tool arguments. No automatic retry was made.');}}, onError, options);
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
    onError: (error: string) => void,
    options: LlmRequestOptions
): void {
    // Do not send provider-specific parameters to an arbitrary compatible proxy.
    const jsonObject = options.responseFormat === 'json_object' && provider.jsonObjectOutput === true
        && model === provider.defaultModel && new URL(baseUrl).origin === new URL(provider.defaultBaseUrl).origin;
    const body = JSON.stringify({
        model,
        stream: true,
        ...(jsonObject ? { response_format: { type: 'json_object' } } : {}),
        messages: wireMessages(messages,false),
        ...wireTools(false,options.tools===true)
    });

    const chatPath = provider.chatPath || '/v1/chat/completions';
    const suffix = /\/v1$|\/v1beta\/openai$/.test(baseUrl) ? chatPath.replace(/^\/v1\//, '/') : chatPath;
    const url = new URL(`${baseUrl}${suffix}`);
    const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? buildAuthHeader(authStyle, apiKey) : {}),
        ...(provider.extraHeaders || {}),
    };

    const tools=new ToolCallCollector();
    makeStreamingRequest(url, headers, body, provider.label, (data) => {
        const event = JSON.parse(data);
        tools.consume(event,false);
        const content = event.choices?.[0]?.delta?.content;
        if (content) {
            onChunk(content);
        }
    }, () => {try{options.onTools?.(tools.finish());onDone();}catch{onError('AI returned malformed tool arguments. No automatic retry was made.');}}, onError, options);
}

/** Unknown models/endpoints retain text chat rather than receiving unsupported tool parameters. */
export function supportsChatTools(config:LlmConfig):boolean {
    const p=PROVIDER_REGISTRY[config.provider];
    return !!p && p.toolCalls===true
        && (!config.model||config.model===p.defaultModel)
        && (!config.baseUrl||config.baseUrl.replace(/\/+$/,'')===p.defaultBaseUrl.replace(/\/+$/,''));
}
export async function callLlmChat(config:LlmConfig,messages:ChatMessage[],options:LlmRequestOptions={}):Promise<AiReply>{
    let toolCalls:AiReply['toolCalls']=[];
    const tools=options.tools===true&&supportsChatTools(config);
    const text=await callLlmFull(config,messages,{...options,tools,onTools:calls=>{toolCalls=calls;}});
    if(toolCalls.length&&!tools&&!messages.some(m=>m.tool_calls?.length))throw Error('The model requested an unoffered tool. No read was executed.');
    return {text:config.apiKey?text.split(config.apiKey).join('[REDACTED]'):text,toolCalls};
}

/**
 * Non-streaming wrapper: accumulates all chunks and resolves with the full response.
 */
export function callLlmFull(config: LlmConfig, messages: ChatMessage[], options: LlmRequestOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        let result = '';
        streamLlmResponse(
            config,
            messages,
            (chunk) => { result += chunk; },
            () => { resolve(result); },
            (error) => { reject(new Error(error)); },
            options
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

// Only fixed Node error codes and fixed guidance may cross into the UI.
// Raw messages, nested causes, hostnames and request objects can contain secrets.
const CONNECTION_ERROR_GUIDANCE: Readonly<Record<string, string>> = {
    ENOTFOUND: 'DNS lookup failed. Check the configured host and DNS connection.',
    EAI_AGAIN: 'DNS lookup is temporarily unavailable. Retry after checking the connection.',
    ECONNREFUSED: 'The connection was refused. Check that the endpoint service and port are available.',
    ECONNRESET: 'The connection was reset. Check the endpoint, proxy or firewall connection.',
    EPIPE: 'The connection closed while sending. Check the endpoint or proxy connection.',
    ETIMEDOUT: 'The connection timed out. Check the endpoint, proxy or firewall connection.',
    ESOCKETTIMEDOUT: 'The connection timed out. Check the endpoint, proxy or firewall connection.',
    ENETUNREACH: 'The network route is unavailable. Check the network, VPN or proxy connection.',
    EHOSTUNREACH: 'The endpoint is unreachable. Check the network, VPN or proxy connection.',
    CERT_HAS_EXPIRED: 'TLS certificate validation failed because a certificate expired. Do not disable certificate verification.',
    CERT_NOT_YET_VALID: 'TLS certificate validation failed. Check the system clock and certificate dates.',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate trust failed. Check the endpoint or configured certificate authority.',
    SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate trust failed. Check the endpoint or proxy certificate authority.',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate trust failed. Check the endpoint or proxy certificate chain.',
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'TLS certificate trust failed. Check the configured certificate authority.',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate hostname validation failed. Check the endpoint and proxy configuration.',
    EPROTO: 'TLS or protocol negotiation failed. Check the endpoint protocol and proxy configuration.',
    EMFILE: 'This editor process has exhausted available file or socket handles. Close unused work and restart this window.',
    ENFILE: 'The system has exhausted available file handles. Close unused work and retry.',
    EADDRNOTAVAIL: 'A local network address or socket is unavailable. Check network state and concurrent connections.'
};

export function formatProviderConnectionError(error: unknown): string {
    try {
        const code = (error as { code?: unknown } | null)?.code;
        if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(CONNECTION_ERROR_GUIDANCE, code)) {
            return `AI request failed (${code}). ${CONNECTION_ERROR_GUIDANCE[code]}`;
        }
    } catch { /* An untrusted error property must not escape or become output. */ }
    return 'AI request failed (NETWORK_UNKNOWN). Check the configured endpoint and connection. No automatic retry was made.';
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
    onError: (error: string) => void,
    requestOptions: LlmRequestOptions
): void {
    if (requestOptions.signal?.aborted) { onError('AI request cancelled.'); return; }
    if (Buffer.byteLength(body) > 512 * 1024) { onError('AI request exceeds the metadata/history limit. Ask a narrower question.'); return; }
    let finished = false;
    let terminal = false;
    let totalBytes = 0;
    let outputChars = 0;
    let response: http.IncomingMessage | undefined;
    let req: http.ClientRequest;
    const finish = (error?: string) => {
        if (finished) { return; }
        finished = true;
        clearTimeout(timer);
        requestOptions.signal?.removeEventListener('abort', abort);
        if (error) {
            response?.destroy();
            req?.destroy();
            onError(error);
        } else { onDone(); }
    };
    const abort = () => finish('AI request cancelled. An approved request may already have reached the provider.');
    const timeoutMs = Math.min(120000, Math.max(1, requestOptions.timeoutMs || 120000));
    const timer = setTimeout(() => finish('AI request deadline exceeded. No automatic retry was made.'), timeoutMs);
    const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
    };

    const transport = url.protocol === 'https:' ? https : http;
    try {
        req = transport.request(options, (res) => {
        response = res;
        if (finished) { res.destroy(); return; }
        if (res.statusCode !== 200) {
            finish(formatProviderHttpError(providerLabel, res.statusCode || 0));
            return;
        }

        let buffer = '';
        // Keep IncomingMessage chunks as buffers: affected Node inspector
        // versions require byteLength and reject setEncoding() string chunks.
        // Decode separately so multibyte UTF-8 survives network boundaries.
        // Request-time loading also keeps the build-only provider catalogue portable.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { StringDecoder } = require('string_decoder') as typeof import('string_decoder');
        const decoder = new StringDecoder('utf8');
        const consume = (line: string) => {
            if (finished || !line.startsWith('data:')) { return; }
            const data = line.slice(5).trim();
            if (!data) { return; }
            if (data === '[DONE]') { terminal = true; return; }
            try {
                const event = JSON.parse(data);
                if (event.error || event.type === 'error') { finish('AI provider reported a streaming error. No automatic retry was made.'); return; }
                const refusal = event.choices?.[0]?.delta?.refusal ?? event.choices?.[0]?.message?.refusal;
                if (typeof refusal === 'string' && refusal.length) {
                    finish('AI provider declined this request. No complete investigation was produced; no automatic retry was made.'); return;
                }
                const reason = event.choices?.[0]?.finish_reason;
                if (reason === 'length' || reason === 'content_filter' || event.delta?.stop_reason === 'max_tokens') {
                    finish('AI response was incomplete or filtered. Ask a narrower question.'); return;
                }
                if (reason || event.type === 'message_stop') { terminal = true; }
                const text = event.delta?.text ?? event.choices?.[0]?.delta?.content;
                if (typeof text === 'string') { outputChars += text.length; }
                if (outputChars > 32768) { finish('AI response exceeded the size limit. Ask a narrower question.'); return; }
                onSseData(data);
            } catch { finish('AI provider returned an invalid streaming event.'); }
        };
        res.on('data', (chunk) => {
            if (finished) { return; }
            totalBytes += Buffer.byteLength(chunk);
            buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
            if (totalBytes > 2 * 1024 * 1024 || Buffer.byteLength(buffer) > 256 * 1024) {
                finish('AI response exceeded the stream limit. Ask a narrower question.'); return;
            }
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) { consume(line.trimEnd()); }
        });
        res.on('aborted', () => finish('AI response was interrupted. No automatic retry was made.'));
        res.on('error', () => finish('AI response could not be read.'));
        res.on('end', () => {
            buffer += decoder.end();
            if (buffer.trim()) { consume(buffer.trimEnd()); }
            if (!finished) { finish(terminal ? undefined : 'AI response ended without completion. No automatic retry was made.'); }
        });
        });
    } catch {
        finish('AI request configuration is invalid. Check provider, model and endpoint.');
        return;
    }

    req.on('error', error => finish(formatProviderConnectionError(error)));
    requestOptions.signal?.addEventListener('abort', abort, { once: true });
    if (requestOptions.signal?.aborted) { abort(); return; }

    req.write(body);
    req.end();
}
