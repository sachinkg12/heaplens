import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'http';
import { AddressInfo } from 'net';
import { ChatMessage, streamLlmResponse, callLlmFull, formatProviderConnectionError, PROVIDER_REGISTRY } from '../llmClient';
import { EvidenceLedger, investigate, investigationSeed } from '../aiInvestigation';

const TEST_MESSAGES: ChatMessage[] = [
    { role: 'user', content: 'test request' }
];

async function withErrorServer(
    statusCode: number,
    responseBody: string,
    run: (baseUrl: string) => Promise<void>
): Promise<void> {
    const server = http.createServer((_request, response) => {
        response.writeHead(statusCode, { 'Content-Type': 'application/json' });
        response.end(responseBody);
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address() as AddressInfo;
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
}

function requestError(baseUrl: string, apiKey: string): Promise<string> {
    return new Promise(resolve => {
        streamLlmResponse(
            { provider: 'openai', apiKey, baseUrl },
            TEST_MESSAGES,
            () => undefined,
            () => resolve('unexpected success'),
            resolve
        );
    });
}

test('does not expose an API key echoed by a provider authentication error', async () => {
    const secret = 'p1-11-secret-do-not-leak';
    const body = JSON.stringify({
        error: {
            message: `Incorrect API key provided: ${secret}`,
            code: 'invalid_api_key'
        }
    });

    await withErrorServer(401, body, async baseUrl => {
        const error = await requestError(baseUrl, secret);
        assert.equal(
            error,
            'OpenAI (GPT) API error (401): Authentication failed. Verify the configured API key.'
        );
        assert.doesNotMatch(error, /p1-11-secret-do-not-leak/);
        assert.doesNotMatch(error, /Incorrect API key provided/);
    });
});
test('does not forward arbitrary provider response bodies for other HTTP errors', async () => {
    const secret = 'p1-11-secret-in-bad-request';
    const malformedBody = `upstream rejected token ${secret} <html>internal details</html>`;

    await withErrorServer(400, malformedBody, async baseUrl => {
        const error = await requestError(baseUrl, secret);
        assert.equal(
            error,
            'OpenAI (GPT) API error (400): Request rejected. Check the provider, model, and base URL settings.'
        );
        assert.doesNotMatch(error, /p1-11-secret-in-bad-request/);
        assert.doesNotMatch(error, /internal details/);
    });
});

test('partial or malformed streams cannot become successful completed answers', async () => {
    const bodies = [
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        'data: {bad-json}\n\ndata: [DONE]\n\n',
        'data: {"error":{"message":"TEST_ONLY_SECRET"}}\n\n',
        'data: {"choices":[{"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
    ];
    for (const body of bodies) {
        await withErrorServer(200, body, async baseUrl => {
            await assert.rejects(callLlmFull({ provider: 'openai', apiKey: 'TEST_ONLY_KEY', baseUrl }, TEST_MESSAGES),
                error => error instanceof Error && /completion|invalid|streaming error|incomplete/.test(error.message) && !error.message.includes('TEST_ONLY_SECRET'));
        });
    }
});

test('stream parser accepts normal completion and a terminal event without a final newline', async () => {
    const body = 'data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]';
    await withErrorServer(200, body, async baseUrl => {
        assert.equal(await callLlmFull({ provider: 'openai', apiKey: 'TEST_ONLY_KEY', baseUrl }, TEST_MESSAGES), 'answer');
    });
});

test('pre-cancelled requests make no connection and hanging streams have a deadline', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(callLlmFull({ provider: 'openai', apiKey: 'TEST_ONLY_KEY', baseUrl: 'http://127.0.0.1:1' }, TEST_MESSAGES,
        { signal: controller.signal }), /cancelled/);
    const server = http.createServer((_request, response) => { response.writeHead(200); response.write(': heartbeat\n\n'); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
        await assert.rejects(callLlmFull({ provider: 'openai', apiKey: 'TEST_ONLY_KEY', baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port },
            TEST_MESSAGES, { timeoutMs: 25 }), /deadline/);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('oversized answers fail and endpoint failures do not leak request metadata', async () => {
    await withErrorServer(200, 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'a'.repeat(32769) } }] }) + '\n\ndata: [DONE]\n\n', async baseUrl => {
        await assert.rejects(callLlmFull({ provider: 'openai', apiKey: 'TEST_ONLY_KEY', baseUrl }, TEST_MESSAGES), /size limit/);
    });
    for (const baseUrl of ['https://user:TEST_ONLY_PASSWORD@example.test', 'file:///private', 'https://example.test/?token=TEST_ONLY_KEY']) {
        await assert.rejects(callLlmFull({ provider: 'openai', apiKey: 'TEST_ONLY_KEY', baseUrl }, TEST_MESSAGES),
            error => error instanceof Error && /endpoint/i.test(error.message) && !/TEST_ONLY|private/.test(error.message));
    }
});

test('connection diagnostics admit only known codes and never raw error details', () => {
    const groups: Record<string, string[]> = {
        DNS: ['ENOTFOUND', 'EAI_AGAIN'],
        connection: ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'],
        network: ['ENETUNREACH', 'EHOSTUNREACH'],
        TLS: ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
            'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'EPROTO'],
        handles: ['EMFILE', 'ENFILE'],
        socket: ['EADDRNOTAVAIL']
    };
    for (const [category, codes] of Object.entries(groups)) {
        for (const code of codes) {
            const result = formatProviderConnectionError({ code, message: 'PRIVATE_KEY_PROMPT_PATH',
                hostname: 'PRIVATE_HOST', cause: new Error('PRIVATE_CAUSE') });
            assert.ok(result.startsWith(`AI request failed (${code}).`), code);
            assert.ok(result.toLowerCase().includes(category.toLowerCase()), code);
            assert.doesNotMatch(result, /PRIVATE_/);
        }
    }
});

test('unknown, hostile and malformed connection errors have one safe fallback', () => {
    const fallback = formatProviderConnectionError(undefined);
    for (const error of [null, undefined, 'PRIVATE_KEY', new Error('PRIVATE_KEY'),
        { code: 'ENOTFOUND PRIVATE_KEY' }, { code: 'toString' }, { code: '__proto__' },
        { code: { toString: () => { throw new Error('PRIVATE_KEY'); } } },
        { get code(): never { throw new Error('PRIVATE_KEY'); } }]) {
        assert.equal(formatProviderConnectionError(error), fallback);
    }
    assert.match(fallback, /NETWORK_UNKNOWN/);
    assert.doesNotMatch(fallback, /PRIVATE_/);
});

test('a refused connection reaches the UI as a safe code without retrying', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await assert.rejects(callLlmFull({ provider: 'openai', apiKey: 'PRIVATE_KEY',
        baseUrl: `http://127.0.0.1:${address.port}` }, [{ role: 'user', content: 'PRIVATE_PROMPT' }]), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\(ECONNREFUSED\)/);
        assert.doesNotMatch(error.message, /PRIVATE_|127\.0\.0\.1|\/v1\/|Bearer/);
        return true;
    });
});

test('a socket reset reaches the UI once and does not trigger an automatic retry', async () => {
    let requests = 0;
    const server = http.createServer((_request, response) => { requests++; response.destroy(); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
        const address = server.address() as AddressInfo;
        await assert.rejects(callLlmFull({ provider: 'openai', apiKey: 'PRIVATE_KEY',
            baseUrl: `http://127.0.0.1:${address.port}` }, TEST_MESSAGES), /\(ECONNRESET\)/);
        assert.equal(requests, 1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('separate UTF-8 decoding preserves multibyte characters across byte-sized SSE chunks', async () => {
    const answer = 'café 東京 🌱';
    for (const provider of ['openai', 'anthropic']) {
        const event = provider === 'anthropic'
            ? { type: 'content_block_delta', delta: { text: answer } }
            : { choices: [{ delta: { content: answer } }] };
        const ending = provider === 'anthropic' ? JSON.stringify({ type: 'message_stop' }) : '[DONE]';
        const bytes = Buffer.from(`data: ${JSON.stringify(event)}\n\ndata: ${ending}`);
        const server = http.createServer((_request, response) => {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            let index = 0;
            const next = () => {
                if (index === bytes.length) { response.end(); return; }
                response.write(bytes.subarray(index, ++index));
                setImmediate(next);
            };
            next();
        });
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        try {
            const address = server.address() as AddressInfo;
            assert.equal(await callLlmFull({ provider, apiKey: 'SYNTHETIC_KEY',
                baseUrl: `http://127.0.0.1:${address.port}` }, TEST_MESSAGES), answer);
        } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    }
});

test('HTTP responses stay byte-oriented for debugger network inspection', async () => {
    // Observe the public HTTP response without depending on an installed IDE.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const transport = require('http') as { request: typeof http.request };
    const original = transport.request;
    let encoding: string | null | undefined;
    let sawData = false;
    let buffersOnly = true;
    transport.request = new Proxy(original, {
        apply(target, receiver, args) {
            const callback = args[args.length - 1] as (response: http.IncomingMessage) => void;
            args[args.length - 1] = (response: http.IncomingMessage) => {
                callback(response);
                encoding = response.readableEncoding;
                response.on('data', chunk => { sawData = true; buffersOnly = buffersOnly && Buffer.isBuffer(chunk); });
            };
            return Reflect.apply(target, receiver, args);
        }
    });
    try {
        await withErrorServer(200, 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', async baseUrl => {
            assert.equal(await callLlmFull({ provider: 'openai', apiKey: 'SYNTHETIC_KEY', baseUrl }, TEST_MESSAGES), 'ok');
        });
        assert.equal(encoding, null, 'Do not call setEncoding on the HTTP response; decode buffers separately.');
        assert.ok(sawData && buffersOnly);
    } finally { transport.request = original; }
});

test('optional JSON mode follows declared capability and exact origin, not vendor identity', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += chunk.toString(); });
        request.on('end', () => {
            bodies.push(JSON.parse(body));
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end('data: {"choices":[{"delta":{"content":"{}"}}]}\n\ndata: [DONE]\n\n');
        });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    // Redirect only this test's synthetic HTTPS requests to its loopback server.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const transport = require('https') as typeof import('https');
    const original = transport.request;
    const address = server.address() as AddressInfo;
    transport.request = new Proxy(original, {
        apply(_target, _receiver, args) {
            return http.request({ ...args[0], hostname: '127.0.0.1', port: address.port }, args[1]);
        }
    });
    // Synthetic second provider proves extension by registry data, not an identity branch.
    PROVIDER_REGISTRY.synthetic = { ...PROVIDER_REGISTRY.openai, label: 'Synthetic', defaultBaseUrl: 'https://second.example.test' };
    try {
        const cases = [
            { provider: 'openai', baseUrl: undefined, json: true, expected: true },
            { provider: 'openai', baseUrl: 'https://api.openai.com/v1', json: true, expected: true },
            { provider: 'openai', baseUrl: undefined, json: false, expected: false },
            { provider: 'openai', baseUrl: 'https://custom.example.test/v1', json: true, expected: false },
            { provider: 'openai', baseUrl: 'https://api.openai.com.example.test', json: true, expected: false },
            { provider: 'groq', baseUrl: 'https://api.openai.com', json: true, expected: false },
            { provider: 'openai', baseUrl: undefined, model: 'unverified-model', json: true, expected: false },
            { provider: 'synthetic', baseUrl: undefined, json: true, expected: true },
            { provider: 'synthetic', baseUrl: 'https://second.example.test/v1', json: true, expected: true },
            { provider: 'synthetic', baseUrl: 'https://second.example.test:444', json: true, expected: false },
            { provider: 'synthetic', baseUrl: 'https://api.openai.com', json: true, expected: false }
        ];
        for (const entry of cases) {
            assert.equal(await callLlmFull({ provider: entry.provider, baseUrl: entry.baseUrl, model: entry.model, apiKey: 'SYNTHETIC_KEY' },
                [{ role: 'system', content: 'Return JSON.' }, ...TEST_MESSAGES], entry.json ? { responseFormat: 'json_object' } : {}), '{}');
            assert.deepEqual(bodies.at(-1)?.response_format, entry.expected ? { type: 'json_object' } : undefined);
        }
        assert.equal(bodies.length, cases.length);
    } finally { delete PROVIDER_REGISTRY.synthetic; transport.request = original; await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('all ten presets preserve natural Chat on custom endpoints without requiring tool or JSON support', async () => {
    assert.equal(Object.keys(PROVIDER_REGISTRY).length, 10);
    for (const [provider, definition] of Object.entries(PROVIDER_REGISTRY)) {
        for (const mode of ['plain', 'fenced', 'forged', 'prose']) {
            let calls = 0, reads = 0;
            const server = http.createServer((request, response) => {
                let input = '';
                request.on('data', chunk => { input += chunk.toString(); });
                request.on('end', () => {
                    calls++;
                    const body = JSON.parse(input), anthropic = definition.apiFormat === 'anthropic';
                    assert.equal(body.model, 'test-model');
                    assert.equal(body.response_format, undefined, 'unknown proxy gets no format-specific option');
                    assert.equal(request.headers[anthropic ? 'x-api-key' : 'authorization'], anthropic ? 'SYNTHETIC_KEY' : 'Bearer SYNTHETIC_KEY');
                    const item = body.messages.findLast((m: ChatMessage) => /^(Actual engine evidence|Current bounded metadata)/.test(m.content));
                    const record = JSON.parse(item.content.slice(item.content.indexOf(': ') + 2));
                    let value = 'I can help investigate; inspect the owner lifecycle before assuming a leak.';
                    if (mode === 'forged') {
                        value = 'A claim with invented evidence [E000000000000_1].';
                    } else if (mode === 'prose') { value = 'Here is the answer: ' + value; }
                    else {
                        if (mode === 'fenced') { value = '\ufeff ```JSON\r\n' + value + '\r\n``` '; }
                    }
                    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    response.end('data: ' + JSON.stringify(anthropic ? { type: 'content_block_delta', delta: { text: value } }
                        : { choices: [{ delta: { content: value } }] }) + '\n\ndata: ' + (anthropic ? '{"type":"message_stop"}' : '[DONE]') + '\n\n');
                });
            });
            await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
            try {
                const baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
                const work = investigate({ scope: 'matrix', destination: baseUrl, signal: new AbortController().signal,
                    current: () => true, approve: async () => true,
                    model: (messages, signal, timeoutMs) => callLlmFull({ provider, baseUrl, model: 'test-model', apiKey: 'SYNTHETIC_KEY' }, messages,
                        { signal, timeoutMs }),
                    read: async action => { reads++; assert.equal(action.object_id, '9007199254740993');
                        return { schema_version: 1, operation: 'object', selected: { object_id: action.object_id, class_name: 'Owner', node_type: 'Instance', shallow_size: '24', retained_size: '88' }, rows: [], status: 'complete', truncated: false }; }
                }, new EvidenceLedger('matrix', ['9007199254740993']), 'Investigate', investigationSeed({ total_heap_size: 1024 }, []));
                if (mode !== 'forged') {
                    const result = await work;
                    assert.match(result.text,/I can help/);
                    assert.equal(result.modelCalls, 1); assert.equal(result.reads, 0);
                    assert.equal(calls, 1); assert.equal(reads, 0);
                } else {
                    await assert.rejects(work);
                    assert.equal(calls, 1); assert.equal(reads, 0);
                }
            } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
        }
    }
});

test('provider refusal is reported distinctly without forwarding its text or retrying', async () => {
    for (const refusal of [{ delta: { refusal: 'PRIVATE_REFUSAL_TEXT' } }, { message: { refusal: 'PRIVATE_REFUSAL_TEXT' } }]) {
        await withErrorServer(200, `data: ${JSON.stringify({ choices: [refusal] })}\n\ndata: [DONE]\n\n`, async baseUrl => {
            await assert.rejects(callLlmFull({ provider: 'openai', apiKey: 'SYNTHETIC_KEY', baseUrl }, TEST_MESSAGES), error => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /provider declined/);
                assert.doesNotMatch(error.message, /PRIVATE_/);
                return true;
            });
        });
    }
});

test('provider catalogue loads in the native build sandbox without request-only dependencies', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vm = require('vm') as typeof import('vm');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    const exports: { PROVIDER_REGISTRY?: Record<string, { defaultBaseUrl: string }> } = {};
    const imports: string[] = [];
    vm.runInNewContext(fs.readFileSync(require.resolve('../llmClient'), 'utf8'), { exports, require: (module: string) => {
        imports.push(module);
        if (module === 'http' || module === 'https') { return {}; }
        if (module === 'url') { return { URL }; }
        if (module === './aiToolProtocol') { return require('../aiToolProtocol'); }
        throw new Error('Unexpected build-only dependency.');
    } }, { timeout: 1000 });
    assert.equal(exports.PROVIDER_REGISTRY?.openai.defaultBaseUrl, 'https://api.openai.com');
    assert.ok(!imports.includes('string_decoder'));
});
