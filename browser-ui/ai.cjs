'use strict';
const http = require('node:http'), https = require('node:https'), crypto = require('node:crypto');
function configuration(input, providers) {
    if (!Object.hasOwn(providers, input.provider))
        throw Error('Unknown provider');
    const p = providers[input.provider];
    const base = String(input.baseUrl || p.defaultBaseUrl).replace(/\/+$/, '');
    const url = new URL(base);
    if (base.length > 2048 || url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
        throw Error('Use HTTPS, or HTTP loopback, without URL credentials/query/fragment');
    const model = String(input.model || p.defaultModel);
    if (!/^[A-Za-z0-9_./:@+\-]{1,200}$/.test(model))
        throw Error('Invalid model ID');
    const key = String(input.key || '');
    if (key.length > 4096 || /[^\x21-\x7e]/.test(key) || !key && input.provider !== 'ollama')
        throw Error('Set a valid key for this provider');
    let chatPath = p.chatPath || (p.apiFormat === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
    if (base.endsWith('/v1') || base.endsWith('/v1beta/openai'))
        chatPath = chatPath.replace(/^\/v1\//, '/');
    return { provider: input.provider, model, key, url: new URL(base + chatPath), definition: p, scope: crypto.randomUUID() };
}
const pick = (row, fields) => Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k, row[k]]));
function context(analysis) {
    return {
        summary: pick(analysis.summary || {}, ['total_heap_size', 'reachable_heap_size', 'total_instances', 'total_classes', 'total_arrays', 'total_gc_roots']),
        classes: (analysis.class_histogram || []).slice(0, 20).map(x => pick(x, ['class_name', 'instance_count', 'shallow_size', 'retained_size'])),
        suspects: (analysis.leak_suspects || []).slice(0, 10).map(x => pick(x, ['class_name', 'object_id', 'retained_size', 'retained_percentage'])),
        waste: pick(analysis.waste_analysis || {}, ['total_wasted_bytes', 'duplicate_string_wasted_bytes', 'empty_collection_wasted_bytes'])
    };
}
function objectMetadata(fields) { return fields.map(x => ({ ...pick(x, ['name', 'field_type', 'ref_object_id']), ...(x.ref_summary ? { ref_summary: pick(x.ref_summary, ['class_name', 'retained_size']) } : {}) })); }
// Provider catalogue/protocols are shared at build time; network policy is a host adapter.
function stream(config, messages, onChunk, signal) {
    return new Promise((resolve, reject) => {
        const anthropic = config.definition.apiFormat === 'anthropic';
        const body = Buffer.from(JSON.stringify(anthropic ?
            { model: config.model, stream: true, max_tokens: 4096, system: messages.filter(x => x.role === 'system').map(x => x.content).join('\n'), messages: messages.filter(x => x.role !== 'system') } :
            { model: config.model, stream: true, messages }));
        if (body.length > 512 * 1024)
            return reject(Error('AI request exceeds 512 KiB'));
        const headers = { 'Content-Type': 'application/json', 'Content-Length': body.length, ...config.definition.extraHeaders };
        if (config.key)
            headers[config.definition.authStyle === 'x-api-key' || anthropic ? 'x-api-key' : 'Authorization'] = config.definition.authStyle === 'x-api-key' || anthropic ? config.key : 'Bearer ' + config.key;
        let done = false, answer = '', buffer = '', held = '';
        let request;
        const timer = setTimeout(() => { request?.destroy(); finish(Error('AI request deadline exceeded')); }, 120000);
        function finish(error) { if (done)
            return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error)
            reject(error);
        else {
            if (held)
                onChunk(held);
            resolve(answer + held);
        } }
        function abort() { request?.destroy(); finish(Error('AI request cancelled')); }
        if (signal?.aborted)
            return abort();
        signal?.addEventListener('abort', abort, { once: true });
        request = (config.url.protocol === 'https:' ? https : http).request(config.url, { method: 'POST', headers }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                request.destroy();
                return finish(Error('Provider rejected the request. Check model, credentials, access and limits.'));
            } // No redirects/raw response bodies.
            res.setEncoding('utf8');
            let total = 0, terminal = false;
            res.on('data', chunk => {
                if (done)
                    return;
                total += Buffer.byteLength(chunk);
                buffer += chunk;
                if (total > 2 * 1024 * 1024 || Buffer.byteLength(buffer) > 256 * 1024) {
                    request.destroy();
                    return finish(Error('AI response exceeds limits'));
                }
                let end;
                while ((end = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, end).trim();
                    buffer = buffer.slice(end + 1);
                    if (!line.startsWith('data:'))
                        continue;
                    const data = line.slice(5).trim();
                    if (data === '[DONE]') {
                        terminal = true;
                        continue;
                    }
                    try {
                        const event = JSON.parse(data);
                        if (event.error)
                            throw Error();
                        if (event.type === 'message_stop' || event.choices?.[0]?.finish_reason)
                            terminal = true;
                        const text = anthropic ? event.delta?.text : event.choices?.[0]?.delta?.content;
                        if (typeof text === 'string') {
                            held += text;
                            if (config.key)
                                held = held.split(config.key).join('[REDACTED]');
                            const keep = config.key.length ? Math.min(config.key.length - 1, held.length) : 0;
                            const safe = held.slice(0, held.length - keep);
                            held = held.slice(held.length - keep);
                            answer += safe;
                            onChunk(safe);
                            if (answer.length + held.length > 64000)
                                throw Error();
                        }
                    }
                    catch {
                        request.destroy();
                        return finish(Error('Unsupported or malformed provider stream'));
                    }
                }
            });
            res.on('end', () => finish(terminal ? undefined : Error('Provider stream ended before completion')));
            res.on('error', () => finish(Error('AI connection interrupted')));
        });
        request.on('error', () => finish(Error('AI connection failed or cancelled')));
        request.end(body);
    });
}
module.exports = { configuration, context, objectMetadata, stream };
